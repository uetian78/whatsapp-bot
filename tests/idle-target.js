// A do-nothing process for the idle check's planted controls (tests/app-config.test.js):
// tests/idle-hook.js is preloaded into it with IDLE_TEST_ROGUE set, and the check must
// see the call the hook plants. It stays alive on its IPC channel, as server.js stays
// alive on its listening socket, until the test kills it.
console.log("Listening on idle-target");
