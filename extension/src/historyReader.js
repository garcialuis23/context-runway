'use strict';

// Reads the same usage-history.jsonl file the context-runway statusline
// script (../../statusline) writes to. This extension is a viewer only —
// it never appends to the file itself, so there's a single writer.

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = path.join(os.homedir(), '.claude', 'context-runway');
const HISTORY_FILE = path.join(STATE_DIR, 'usage-history.jsonl');

function readHistory() {
  let raw;
  try {
    raw = fs.readFileSync(HISTORY_FILE, 'utf8');
  } catch {
    return [];
  }

  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

module.exports = { readHistory, HISTORY_FILE, STATE_DIR };
