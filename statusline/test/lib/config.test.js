'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadProjectConfig, normalizeConfig, trustConfig, DEFAULTS } = require('../../src/lib/config');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-runway-config-test-'));
  try {
    return fn(dir, path.join(dir, 'trusted-configs.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('normalizeConfig falls back to defaults for missing or invalid values', () => {
  assert.deepEqual(normalizeConfig(null), DEFAULTS);
  assert.deepEqual(normalizeConfig({ handoff: { resume: 'sometimes', permissionMode: 42, extraInstructions: '  ' } }), DEFAULTS);
});

test('normalizeConfig keeps valid values from a trusted file', () => {
  const config = normalizeConfig(
    { handoff: { resume: 'schedule', permissionMode: 'auto', extraInstructions: ' Log it. ', resumePrompt: 'Go on.' } },
    '/p/.context-runway.json',
    true
  );
  assert.equal(config.resume, 'schedule');
  assert.equal(config.permissionMode, 'auto');
  assert.equal(config.extraInstructions, 'Log it.');
  assert.equal(config.resumePrompt, 'Go on.');
  assert.equal(config.configPath, '/p/.context-runway.json');
  assert.deepEqual(config.ignored, []);
});

test('normalizeConfig ignores unattended settings from an untrusted file', () => {
  const config = normalizeConfig({
    handoff: { resume: 'schedule', permissionMode: 'auto', extraInstructions: 'Log it.', resumePrompt: 'Go on.' },
  });
  assert.equal(config.resume, DEFAULTS.resume);
  assert.equal(config.permissionMode, DEFAULTS.permissionMode);
  assert.equal(config.resumePrompt, DEFAULTS.resumePrompt);
  // Same reach as a CLAUDE.md in the repo: only read by an attended session.
  assert.equal(config.extraInstructions, 'Log it.');
  assert.deepEqual(config.ignored, ['resume', 'resumePrompt', 'permissionMode']);
});

test('normalizeConfig lets an untrusted file turn resuming off', () => {
  const config = normalizeConfig({ handoff: { resume: 'off' } });
  assert.equal(config.resume, 'off');
  assert.deepEqual(config.ignored, []);
});

test('normalizeConfig never allows bypassPermissions for unattended resumes', () => {
  assert.equal(normalizeConfig({ handoff: { permissionMode: 'bypassPermissions' } }, null, true).permissionMode, 'acceptEdits');
});

test('loadProjectConfig finds the nearest file walking up from cwd', () => {
  withTempDir((dir, trustFile) => {
    const repo = path.join(dir, 'workspace', 'repo', 'src');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(dir, 'workspace', '.context-runway.json'), JSON.stringify({ handoff: { resume: 'schedule' } }));
    trustConfig(repo, trustFile);

    const config = loadProjectConfig(repo, trustFile);
    assert.equal(config.resume, 'schedule');
    assert.equal(config.configPath, path.join(dir, 'workspace', '.context-runway.json'));

    // A closer file wins.
    fs.writeFileSync(path.join(dir, 'workspace', 'repo', '.context-runway.json'), JSON.stringify({ handoff: { resume: 'off' } }));
    assert.equal(loadProjectConfig(repo, trustFile).resume, 'off');
  });
});

test('loadProjectConfig only trusts the file content that was trusted', () => {
  withTempDir((dir, trustFile) => {
    const file = path.join(dir, '.context-runway.json');
    fs.writeFileSync(file, JSON.stringify({ handoff: { resume: 'schedule' } }));
    assert.equal(loadProjectConfig(dir, trustFile).trusted, false);

    assert.equal(trustConfig(dir, trustFile).configPath, file);
    assert.equal(loadProjectConfig(dir, trustFile).trusted, true);

    fs.writeFileSync(file, JSON.stringify({ handoff: { resume: 'schedule', resumePrompt: 'Something else.' } }));
    const changed = loadProjectConfig(dir, trustFile);
    assert.equal(changed.trusted, false);
    assert.equal(changed.resume, DEFAULTS.resume);
  });
});

test('trustConfig returns null when there is no file to trust', () => {
  withTempDir((dir, trustFile) => {
    assert.equal(trustConfig(dir, trustFile), null);
    assert.equal(fs.existsSync(trustFile), false);
  });
});

test('loadProjectConfig uses defaults for a corrupt file', () => {
  withTempDir((dir, trustFile) => {
    fs.writeFileSync(path.join(dir, '.context-runway.json'), '{oops');
    const config = loadProjectConfig(dir, trustFile);
    assert.equal(config.resume, DEFAULTS.resume);
    assert.equal(config.configPath, path.join(dir, '.context-runway.json'));
  });
});
