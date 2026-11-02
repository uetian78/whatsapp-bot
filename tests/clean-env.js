// Required first by test files that must not see the machine's own data folder.
// A DATA_DIR (or Railway volume path) left in the shell would otherwise be used
// by the replay harness and the database code, mixing a person's real data into
// a test and failing it. Each test file runs in its own process, so clearing the
// variables here affects that file only.
delete process.env.DATA_DIR;
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
delete process.env.RAILWAY_ENVIRONMENT;
