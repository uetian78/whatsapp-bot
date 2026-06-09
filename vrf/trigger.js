// Exact-phrase trigger for the VRF Selection feature.
// Matches "VRF Selection" only (case-insensitive, ignoring outer/inner extra
// whitespace). Bare "vrf" and the phrase embedded in a longer message do NOT
// match — this is a hard product requirement.
function isVrfTrigger(text) {
  if (typeof text !== 'string') return false;
  return /^\s*vrf\s+selection\s*$/i.test(text);
}

module.exports = { isVrfTrigger };
