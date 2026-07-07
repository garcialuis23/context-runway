#!/usr/bin/env node
'use strict';

// Runs the statusline against the mock fixture with CONTEXT_RUNWAY_STATE_DIR
// pointed at a throwaway temp directory, so `npm test` never writes to the
// real ~/.claude/context-runway/usage-history.jsonl.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-runway-test-'));
const fixturePath = path.join(__dirname, 'fixture.json');
const indexPath = path.join(__dirname, '..', 'src', 'index.js');

const result = spawnSync(process.execPath, [indexPath], {
  input: fs.readFileSync(fixturePath),
  env: { ...process.env, CONTEXT_RUNWAY_STATE_DIR: tmpStateDir },
  encoding: 'utf8',
});

fs.rmSync(tmpStateDir, { recursive: true, force: true });

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 0);
