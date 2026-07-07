#!/usr/bin/env node
'use strict';

// Removes the context-runway statusLine entry from ~/.claude/settings.json,
// leaving everything else untouched. No-op if it isn't installed.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

function main() {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    console.log(`No settings file found at ${SETTINGS_PATH}, nothing to do.`);
    return;
  }

  const isOurs = settings.statusLine?.type === 'command' && settings.statusLine?.command?.includes('context-runway');

  if (!isOurs) {
    console.log('context-runway is not the configured statusLine, leaving settings untouched.');
    return;
  }

  delete settings.statusLine;
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
  console.log(`Removed statusLine entry from ${SETTINGS_PATH}`);
}

main();
