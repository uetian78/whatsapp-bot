const test = require("node:test");
const assert = require("node:assert");
const { whatsappEnabled, requiredEnv } = require("../lib/app-config.js");

test("WhatsApp is on only when WHATSAPP_ENABLED is exactly true", () => {
  assert.equal(whatsappEnabled({ WHATSAPP_TOKEN: "x" }), false);
  assert.equal(whatsappEnabled({ WHATSAPP_ENABLED: "true" }), true);
  for (const v of ["TRUE", "True", "1", "yes", "false", "", " true"]) {
    assert.equal(whatsappEnabled({ WHATSAPP_ENABLED: v }), false, JSON.stringify(v));
  }
});

test("required env without WhatsApp", () => {
  assert.deepEqual(requiredEnv({}), ["GOOGLE_SHEET_ID", "GOOGLE_SERVICE_ACCOUNT_JSON"]);
});

test("required env with WhatsApp adds its three settings", () => {
  assert.deepEqual(requiredEnv({ WHATSAPP_ENABLED: "true" }), [
    "GOOGLE_SHEET_ID", "GOOGLE_SERVICE_ACCOUNT_JSON",
    "VERIFY_TOKEN", "WHATSAPP_TOKEN", "PHONE_NUMBER_ID",
  ]);
});
