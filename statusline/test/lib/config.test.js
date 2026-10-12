'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadProjectConfig, normalizeConfig, DEFAULTS } = require('../../src/lib/config');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-runway-config-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('normalizeConfig falls back to defaults for missing or invalid values', () => {
  assert.deepEqual(normalizeConfig(null), DEFAULTS);
  assert.deepEqual(normalizeConfig({ handoff: { resume: 'sometimes', permissionMode: 42, extraInstructions: '  ' } }), DEFAULTS);
});

test('normalizeConfig keeps valid values', () => {
  const config = normalizeConfig(
    { handoff: { resume: 'schedule', permissionMode: 'auto', extraInstructions: ' Log it. ', resumePrompt: 'Go on.' } },
    '/p/.context-runway.json'
  );
  assert.equal(config.resume, 'schedule');
  assert.equal(config.permissionMode, 'auto');
  assert.equal(config.extraInstructions, 'Log it.');
  assert.equal(config.resumePrompt, 'Go on.');
  assert.equal(config.configPath, '/p/.context-runway.json');
});

test('normalizeConfig never allows bypassPermissions for unattended resumes', () => {
  assert.equal(normalizeConfig({ handoff: { permissionMode: 'bypassPermissions' } }).permissionMode, 'acceptEdits');
});

test('loadProjectConfig finds the nearest file walking up from cwd', () => {
  withTempDir((dir) => {
    const repo = path.join(dir, 'workspace', 'repo', 'src');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(dir, 'workspace', '.context-runway.json'), JSON.stringify({ handoff: { resume: 'schedule' } }));

    const config = loadProjectConfig(repo);
    assert.equal(config.resume, 'schedule');
    assert.equal(config.configPath, path.join(dir, 'workspace', '.context-runway.json'));

    // A closer file wins.
    fs.writeFileSync(path.join(dir, 'workspace', 'repo', '.context-runway.json'), JSON.stringify({ handoff: { resume: 'off' } }));
    assert.equal(loadProjectConfig(repo).resume, 'off');
  });
});

test('loadProjectConfig uses defaults for a corrupt file', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, '.context-runway.json'), '{oops');
    const config = loadProjectConfig(dir);
    assert.equal(config.resume, DEFAULTS.resume);
    assert.equal(config.configPath, path.join(dir, '.context-runway.json'));
  });
});
