#!/usr/bin/env node
'use strict';

// Wires context-runway into ~/.claude/settings.json as the statusLine
// command, plus the handoff hooks (see handoff.js). Safe to re-run: it merges into existing settings rather than
// overwriting the file, and backs up the previous version first.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const INDEX_PATH = path.resolve(__dirname, 'index.js').split(path.sep).join('/');
const HANDOFF_PATH = path.resolve(__dirname, 'handoff.js').split(path.sep).join('/');

// Hook events used by handoff.js, with the mode argument each one passes.
// SessionStart skips 'resume' (that conversation is already loaded), and
// StopFailure only matters when a usage limit ended the turn.
const HANDOFF_HOOKS = [
  { event: 'UserPromptSubmit', mode: 'prompt' },
  { event: 'PostToolUse', mode: 'tool' },
  { event: 'SessionStart', mode: 'start', matcher: 'startup|clear|compact' },
  { event: 'StopFailure', mode: 'stopfail', matcher: 'rate_limit' },
];

// Drops any context-runway handoff hooks already in settings (so re-running
// the installer never duplicates them) and returns what's left. Shared with
// uninstall.js.
function withoutHandoffHooks(hooks) {
  const result = { ...hooks };
  for (const { event } of HANDOFF_HOOKS) {
    if (!Array.isArray(result[event])) continue;
    const kept = result[event]
      .map((group) => ({
        ...group,
        hooks: (group.hooks || []).filter((h) => !isHandoffHook(h)),
      }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length > 0) result[event] = kept;
    else delete result[event];
  }
  return result;
}

function isHandoffHook(hook) {
  return (
    typeof hook?.command === 'string' && hook.command.includes('context-runway') && hook.command.includes('handoff.js')
  );
}

function installHandoffHooks(settings) {
  const hooks = withoutHandoffHooks(settings.hooks || {});
  for (const { event, mode, matcher } of HANDOFF_HOOKS) {
    const group = { hooks: [{ type: 'command', command: `node "${HANDOFF_PATH}" ${mode}`, timeout: 10 }] };
    if (matcher) group.matcher = matcher;
    hooks[event] = [...(hooks[event] || []), group];
  }
  settings.hooks = hooks;
}

function readSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Could not parse existing ${SETTINGS_PATH}: ${err.message}`);
  }
}

function backupSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) return null;
  const backupPath = `${SETTINGS_PATH}.context-runway-backup`;
  fs.copyFileSync(SETTINGS_PATH, backupPath);
  return backupPath;
}

function main() {
  const settings = readSettings();

  const alreadyInstalled =
    settings.statusLine?.type === 'command' && settings.statusLine?.command?.includes('context-runway');

  const backupPath = backupSettings();

  settings.statusLine = {
    type: 'command',
    command: `node "${INDEX_PATH}"`,
    padding: 1,
    // Without this, the "resets in Xh Ym" countdown only updates on your
    // next message — leave the terminal idle for hours and it visibly
    // freezes even though the real reset time keeps approaching. Re-running
    // every 60s keeps it live.
    refreshInterval: 60,
  };

  installHandoffHooks(settings);

  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');

  console.log(`${alreadyInstalled ? 'Updated' : 'Installed'} statusLine in ${SETTINGS_PATH}`);
  console.log(`  command: node "${INDEX_PATH}"`);
  console.log(`Installed handoff hooks (${HANDOFF_HOOKS.map((h) => h.event).join(', ')}): node "${HANDOFF_PATH}"`);
  if (backupPath) console.log(`Previous settings backed up to ${backupPath}`);
  console.log('\nRestart Claude Code (or start a new session) to see it take effect.');
}

if (require.main === module) {
  main();
}

module.exports = { withoutHandoffHooks, installHandoffHooks, isHandoffHook };
