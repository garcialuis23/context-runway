#!/usr/bin/env node
'use strict';

// Removes the context-runway statusLine entry and handoff hooks from
// ~/.claude/settings.json, leaving everything else untouched. No-op if
// neither is installed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withoutHandoffHooks } = require('./install');

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
  if (isOurs) delete settings.statusLine;

  const hooksBefore = JSON.stringify(settings.hooks || {});
  const hooks = withoutHandoffHooks(settings.hooks || {});
  const hadHooks = JSON.stringify(hooks) !== hooksBefore;
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;
  else delete settings.hooks;

  if (!isOurs && !hadHooks) {
    console.log('context-runway is not installed, leaving settings untouched.');
    return;
  }

  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
  if (isOurs) console.log(`Removed statusLine entry from ${SETTINGS_PATH}`);
  if (hadHooks) console.log(`Removed handoff hooks from ${SETTINGS_PATH}`);
}

main();
