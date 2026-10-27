'use strict';

// Optional per-project settings for handoff notes, read from the nearest
// .context-runway.json walking up from the session's working directory (the
// same way git finds .git), so one file can cover a folder of repos.
//
//   {
//     "handoff": {
//       "extraInstructions": "Also log the session in docs/sessions/.",
//       "resume": "script",              // "script" | "schedule" | "off"
//       "resumePrompt": "Carry on from your handoff notes.",
//       "permissionMode": "acceptEdits"  // used by scheduled resumes
//     }
//   }
//
// Anything missing or invalid falls back to the defaults below, so a broken
// file never stops the hooks from working.
//
// This file can arrive with a cloned repo, so the settings that make Claude
// run unattended (UNATTENDED_KEYS) only apply once the user has trusted that
// exact file with `node handoff.js trust`. Trust is recorded by content hash
// in the state dir, so editing the file (say, a git pull) needs trusting again.
// Until then those keys fall back to their defaults, and `ignored` lists them.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { STATE_DIR } = require('./history');

const CONFIG_FILE = '.context-runway.json';
const TRUST_FILE = path.join(STATE_DIR, 'trusted-configs.json');

const RESUME_MODES = ['script', 'schedule', 'off'];

// bypassPermissions is deliberately absent, even for trusted files: an
// unattended resume must never be able to skip every permission check.
const PERMISSION_MODES = ['acceptEdits', 'auto', 'manual', 'dontAsk', 'plan'];

const UNATTENDED_KEYS = ['resume', 'resumePrompt', 'permissionMode'];

const DEFAULT_RESUME_PROMPT =
  'The usage limit that interrupted this session has reset. Re-read your handoff notes and continue the task from where it stopped.';

const DEFAULTS = {
  extraInstructions: '',
  resume: 'script',
  resumePrompt: DEFAULT_RESUME_PROMPT,
  permissionMode: 'acceptEdits',
  configPath: null,
  trusted: false,
  ignored: [],
};

function findConfigFile(cwd) {
  let dir = path.resolve(cwd || '.');
  for (;;) {
    const candidate = path.join(dir, CONFIG_FILE);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeConfig(raw, configPath = null, trusted = false) {
  const h = raw && typeof raw.handoff === 'object' && raw.handoff ? raw.handoff : {};
  const config = {
    extraInstructions: nonEmptyString(h.extraInstructions) ?? DEFAULTS.extraInstructions,
    resume: RESUME_MODES.includes(h.resume) ? h.resume : DEFAULTS.resume,
    resumePrompt: nonEmptyString(h.resumePrompt) ?? DEFAULTS.resumePrompt,
    permissionMode: PERMISSION_MODES.includes(h.permissionMode) ? h.permissionMode : DEFAULTS.permissionMode,
    configPath,
    trusted,
    ignored: [],
  };
  if (!trusted) {
    for (const key of UNATTENDED_KEYS) {
      // Turning resuming off only makes things safer, so it never needs trust.
      if (key === 'resume' && config.resume === 'off') continue;
      if (config[key] !== DEFAULTS[key]) {
        config.ignored.push(key);
        config[key] = DEFAULTS[key];
      }
    }
  }
  return config;
}

const hashContent = (text) => crypto.createHash('sha256').update(text).digest('hex');

// Keyed by the resolved path with forward slashes and, on Windows, lower case,
// so the same file always maps to the same entry.
function trustKey(configPath) {
  const p = path.resolve(configPath).split(path.sep).join('/');
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function readTrusted(trustFile = TRUST_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(trustFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function isTrusted(configPath, text, trustFile = TRUST_FILE) {
  return readTrusted(trustFile)[trustKey(configPath)] === hashContent(text);
}

// Trusts the nearest config file for cwd as it reads right now. Returns its
// path and settings, or null if there is none.
function trustConfig(cwd, trustFile = TRUST_FILE) {
  const configPath = findConfigFile(cwd);
  if (!configPath) return null;
  const text = fs.readFileSync(configPath, 'utf8');
  const trusted = readTrusted(trustFile);
  trusted[trustKey(configPath)] = hashContent(text);
  fs.mkdirSync(path.dirname(trustFile), { recursive: true });
  fs.writeFileSync(trustFile, JSON.stringify(trusted, null, 2) + '\n');
  return { configPath, text };
}

function loadProjectConfig(cwd, trustFile = TRUST_FILE) {
  const configPath = findConfigFile(cwd);
  if (!configPath) return { ...DEFAULTS };
  try {
    const text = fs.readFileSync(configPath, 'utf8');
    return normalizeConfig(JSON.parse(text), configPath, isTrusted(configPath, text, trustFile));
  } catch {
    return { ...DEFAULTS, configPath };
  }
}

module.exports = {
  loadProjectConfig,
  normalizeConfig,
  findConfigFile,
  trustConfig,
  isTrusted,
  CONFIG_FILE,
  TRUST_FILE,
  DEFAULTS,
  RESUME_MODES,
  PERMISSION_MODES,
  UNATTENDED_KEYS,
};
