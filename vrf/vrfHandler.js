// vrfHandler.js — CommonJS. Ties everything together for the WhatsApp bot.
//
// Drop these into your existing bot. You already have:
//   - a keyword router (you do this for SMMSe / APMR)
//   - a per-user session store
//   - a Drive service-account uploader that returns a shareable link
//
// Replace the two TODO stubs (sendWhatsApp, uploadToDrive) with your existing
// functions. Everything else is wired.

const { runVrfSelection, summaryToWhatsApp } = require('./vrfClient');
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

// Call from your keyword router when message text === 'vrf' (or contains it).
async function onVrfKeyword(userId) {
  const guided = startGuided();
  sessions.set(userId, { mode: 'vrf', guided, pending: null, ts: Date.now() });
  await sendWhatsApp(userId,
    'VRF selection. You can either:\n' +
    '1) Send a *photo / PDF / xlsx* of the schedule, or\n' +
    '2) Type rows manually.\n\n' +
    'To type manually, first tell me the *project name*.\n' +
    'Or just send the schedule file now.');
}

// Call for every inbound message while session.mode === 'vrf'.
// `attachment` (optional): { base64, mediaType, filename }
async function onVrfMessage(userId, text, attachment) {
  const s = sessions.get(userId);
  if (!s) return false; // not in a vrf session

  try {
    // ---- if we're awaiting a yes/no confirmation on extracted rows ----
    if (s.pending) {
      const ans = (text || '').trim().toLowerCase();
      if (/^(y|yes|ok|go|build|confirm)$/.test(ans)) {
        const { project, discount, rows } = s.pending;
        s.pending = null;
        await finishAndSend(userId, { project, discount, rows });
        sessions.delete(userId);
        return true;
      }
      if (/^(n|no|cancel|stop)$/.test(ans)) {
        s.pending = null;
        await sendWhatsApp(userId, 'Cancelled. Send a clearer file, or type rows manually (project name first).');
        return true;
      }
      await sendWhatsApp(userId, 'Reply *yes* to build, or *no* to cancel.');
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
    await sendWhatsApp(userId, `Something went wrong: ${err.message}`);
    return true;
  }
}

async function finishAndSend(userId, input) {
  await sendWhatsApp(userId, 'Running selection...');
  const { xlsxBuffer, summary } = await runVrfSelection(input);
  const filename = `${(summary.project || 'VRF').replace(/[^\w]+/g, '_')}_VRF_BOQ.xlsx`;
  await deps.sendDocument(userId, xlsxBuffer, filename);
  await sendWhatsApp(userId, summaryToWhatsApp(summary)); // no link: file sent directly
}

module.exports = { initVrf, onVrfKeyword, onVrfMessage, sessions };
