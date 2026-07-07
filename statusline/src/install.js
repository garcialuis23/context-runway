#!/usr/bin/env node
'use strict';

// Wires context-runway into ~/.claude/settings.json as the statusLine
// command. Safe to re-run: it merges into existing settings rather than
// overwriting the file, and backs up the previous version first.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const INDEX_PATH = path.resolve(__dirname, 'index.js').split(path.sep).join('/');

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
  };

  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');

  console.log(`${alreadyInstalled ? 'Updated' : 'Installed'} statusLine in ${SETTINGS_PATH}`);
  console.log(`  command: node "${INDEX_PATH}"`);
  if (backupPath) console.log(`Previous settings backed up to ${backupPath}`);
  console.log('\nRestart Claude Code (or start a new session) to see it take effect.');
}

main();
