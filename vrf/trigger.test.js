const { test } = require('node:test');
const assert = require('node:assert');
const { isVrfTrigger } = require('./trigger');

test('matches the exact phrase, case-insensitive, with surrounding whitespace', () => {
  assert.equal(isVrfTrigger('VRF Selection'), true);
  assert.equal(isVrfTrigger('vrf selection'), true);
  assert.equal(isVrfTrigger('  VRF   Selection  '), true);
});

test('does not match bare keyword or phrase inside a sentence', () => {
  assert.equal(isVrfTrigger('vrf'), false);
  assert.equal(isVrfTrigger('please run vrf selection now'), false);
  assert.equal(isVrfTrigger('vrf selector'), false);
  assert.equal(isVrfTrigger(''), false);
  assert.equal(isVrfTrigger(undefined), false);
});
