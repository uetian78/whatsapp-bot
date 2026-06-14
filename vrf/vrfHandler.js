// vrfHandler.js — CommonJS. Ties everything together for the WhatsApp bot.
//
// Drop these into your existing bot. You already have:
//   - a keyword router (you do this for SMMSe / APMR)
//   - a per-user session store
//   - a Drive service-account uploader that returns a shareable link
//
// Replace the two TODO stubs (sendWhatsApp, uploadToDrive) with your existing
// functions. Everything else is wired.

const { runVrfSelection, runVrfFromText, summaryToWhatsApp, warmUpSidecar } = require('./vrfClient');
const {
  startGuided, guidedStep,
  rowsFromWorkbook, rowsFromImageOrPdf,
  extractionConfirmText,
} = require('./vrfIntake');

// ---- injected by the bot via initVrf() -------------------------------------
// deps.sendText(userId, text)            -> outbound WhatsApp text
// deps.sendDocument(userId, buf, name)   -> outbound WhatsApp document (xlsx)
let deps = {
  sendText: async () => { throw new Error('VRF not initialized: call initVrf({ sendText, sendDocument })'); },
  sendDocument: async () => { throw new Error('VRF not initialized: call initVrf({ sendText, sendDocument })'); },
};
function initVrf(d) { deps = { ...deps, ...d }; }

async function sendWhatsApp(userId, text) {
  return deps.sendText(userId, text);
}
// ----------------------------------------------------------------------------

const sessions = new Map(); // userId -> { mode:'vrf', guided, pending? }

// A pasted schedule has at least 2 lines and each line contains a comma or tab
// (delimiter) plus at least one digit — distinguishes it from a project name or
// a single typed row.
function isPastedSchedule(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  return lines.filter((l) => (l.includes(',') || l.includes('\t')) && /\d/.test(l)).length >= 2;
}

// Call from your keyword router when message text === 'vrf' (or contains it).
async function onVrfKeyword(userId) {
  const guided = startGuided();
  sessions.set(userId, { mode: 'vrf', guided, pending: null, ts: Date.now() });
  // Wake the (possibly spun-down) sidecar in the background so it's warm by the
  // time the user sends a schedule and confirms. Best-effort, never blocks.
  warmUpSidecar().catch(() => {});
  await sendWhatsApp(userId,
    '*VRF Selection* — Toshiba SMMSe BOQ builder.\n\n' +
    'You can:\n' +
    '1️⃣ *Paste a CSV schedule* — paste your schedule table now (project name first if you want)\n' +
    '2️⃣ *Send a file* — photo, PDF, or xlsx of the schedule\n' +
    '3️⃣ *Type rows manually* — line by line\n\n' +
    'For manual entry, start by telling me the *project name*.\n' +
    'Or paste / upload your schedule now and I\'ll start building.\n\n' +
    '_Type *exit* at any time to cancel._');
}

// Call for every inbound message while session.mode === 'vrf'.
// `attachment` (optional): { base64, mediaType, filename }
async function onVrfMessage(userId, text, attachment) {
  const s = sessions.get(userId);
  if (!s) return false; // not in a vrf session

  // Universal escape hatch — works at ANY point, including after a build error
  // (e.g. sidecar 502) left the session open. Checked before anything else so
  // "exit"/"cancel" is never swallowed by the guided flow as a project name.
  if (/^(exit|cancel|quit|stop|reset|end)$/i.test((text || '').trim())) {
    sessions.delete(userId);
    await sendWhatsApp(userId, '✅ VRF selection cancelled. Type *VRF Selection* to start again.');
    return true;
  }

  try {
    // ---- if we're awaiting a yes/no confirmation on extracted rows ----
    if (s.pending) {
      const ans = (text || '').trim().toLowerCase();
      if (/^(y|yes|ok|go|build|confirm)$/.test(ans)) {
        const { project, discount, rows } = s.pending;
        try {
          await finishAndSend(userId, { project, discount, rows });
          sessions.delete(userId); // success -> done
        } catch (err) {
          // Keep the session + pending so the user can retry or exit cleanly,
          // instead of being stranded in a half-open session after a 502.
          await sendWhatsApp(userId,
            `⚠️ ${err.message}\n\nReply *yes* to try again, or *exit* to cancel.`);
        }
        return true;
      }
      if (/^(n|no)$/.test(ans)) {
        s.pending = null;
        await sendWhatsApp(userId, 'Okay, dropped that extraction. Send a clearer file, or type *exit* to leave.');
        return true;
      }
      await sendWhatsApp(userId, 'Reply *yes* to build, *no* to redo, or *exit* to cancel.');
      return true;
    }

    // ---- detect pasted CSV/TSV schedule (multi-line with delimiters) ----
    if (!attachment && text && isPastedSchedule(text)) {
      const project = s.guided.project || 'VRF Project';
      await sendWhatsApp(userId, 'Detected a pasted schedule — building BOQ now...');
      await sendWhatsApp(userId, 'Running selection… this can take a moment on first use, please hold on.');
      const onProgress = (sec) =>
        sendWhatsApp(userId, `⏳ Still working… engine waking up (${sec}s). Your BOQ is on the way.`);
      const { xlsxBuffer, summary, warnings, excluded } = await runVrfFromText(
        project, text, s.guided.discount, onProgress
      );
      const filename = `${(summary.project || 'VRF').replace(/[^\w]+/g, '_')}_VRF_BOQ.xlsx`;
      await deps.sendDocument(userId, xlsxBuffer, filename);
      await sendWhatsApp(userId, summaryToWhatsApp(summary));
      if (warnings && warnings.length) {
        await sendWhatsApp(userId, `⚠️ *Warnings:*\n${warnings.join('\n')}`);
      }
      if (excluded && excluded.length) {
        await sendWhatsApp(userId, `ℹ️ *Excluded rows* (non-VRF):\n${excluded.join(', ')}`);
      }
      sessions.delete(userId);
      return true;
    }

    // ---- file intake takes priority if an attachment is present ----
    if (attachment && attachment.base64) {
      const mt = attachment.mediaType || '';
      let rows;
      let viaModel = null;
      if (/sheet|excel|spreadsheet|csv/i.test(mt) || /\.(xlsx|xls|csv)$/i.test(attachment.filename || '')) {
        // deterministic, no Claude, no confirmation needed beyond engine summary
        rows = rowsFromWorkbook(Buffer.from(attachment.base64, 'base64'));
      } else if (/image\/|application\/pdf/i.test(mt)) {
        await sendWhatsApp(userId, 'Reading the schedule...');
        const out = await rowsFromImageOrPdf(attachment.base64, mt.includes('pdf') ? 'application/pdf' : mt);
        rows = out.rows;
        viaModel = out.model;
      } else {
        await sendWhatsApp(userId, 'Unsupported file. Send an image, PDF, or xlsx.');
        return true;
      }

      if (!rows.length) {
        await sendWhatsApp(userId, 'No usable rows found. Try a clearer file or type rows manually.');
        return true;
      }

      const project = s.guided.project || (attachment.filename || 'VRF Project').replace(/\.[^.]+$/, '');

      // xlsx/csv -> trust and build directly. image/PDF -> confirm first.
      if (viaModel) {
        s.pending = { project, discount: s.guided.discount, rows };
        await sendWhatsApp(userId, extractionConfirmText(rows));
        return true;
      }
      await finishAndSend(userId, { project, discount: s.guided.discount, rows });
      sessions.delete(userId);
      return true;
    }

    // ---- otherwise run the guided text flow ----
    const step = guidedStep(s.guided, text);
    if (step.reply) await sendWhatsApp(userId, step.reply);
    if (step.done) {
      await finishAndSend(userId, {
        project: s.guided.project,
        discount: s.guided.discount,
        rows: s.guided.rows,
      });
      sessions.delete(userId);
    }
    return true;
  } catch (err) {
    await sendWhatsApp(userId, `Something went wrong: ${err.message}\n\n(Type *exit* to cancel, or try again.)`);
    return true;
  }
}

async function finishAndSend(userId, input) {
  await sendWhatsApp(userId, 'Running selection… waking the engine if it was idle — this can take up to a minute on first use, please hold on.');
  // Heartbeat every ~10s while the free-tier sidecar wakes, so the user knows
  // it's still working rather than wondering if it stalled.
  const onProgress = (sec) =>
    sendWhatsApp(userId, `⏳ Still working… the engine was idle and is waking up (${sec}s). I’ll send your BOQ the moment it’s ready.`);
  const { xlsxBuffer, summary } = await runVrfSelection(input, onProgress);
  const filename = `${(summary.project || 'VRF').replace(/[^\w]+/g, '_')}_VRF_BOQ.xlsx`;
  await deps.sendDocument(userId, xlsxBuffer, filename);
  await sendWhatsApp(userId, summaryToWhatsApp(summary)); // no link: file sent directly
}

module.exports = { initVrf, onVrfKeyword, onVrfMessage, sessions };
