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

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = '.context-runway.json';

const RESUME_MODES = ['script', 'schedule', 'off'];

// bypassPermissions is deliberately absent: this file can arrive with a
// cloned repo, and an unattended resume must never be able to skip every
// permission check because of it.
const PERMISSION_MODES = ['acceptEdits', 'auto', 'manual', 'dontAsk', 'plan'];

const DEFAULT_RESUME_PROMPT =
  'The usage limit that interrupted this session has reset. Re-read your handoff notes and continue the task from where it stopped.';

const DEFAULTS = {
  extraInstructions: '',
  resume: 'script',
  resumePrompt: DEFAULT_RESUME_PROMPT,
  permissionMode: 'acceptEdits',
  configPath: null,
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

function normalizeConfig(raw, configPath = null) {
  const h = raw && typeof raw.handoff === 'object' && raw.handoff ? raw.handoff : {};
  return {
    extraInstructions: nonEmptyString(h.extraInstructions) ?? DEFAULTS.extraInstructions,
    resume: RESUME_MODES.includes(h.resume) ? h.resume : DEFAULTS.resume,
    resumePrompt: nonEmptyString(h.resumePrompt) ?? DEFAULTS.resumePrompt,
    permissionMode: PERMISSION_MODES.includes(h.permissionMode) ? h.permissionMode : DEFAULTS.permissionMode,
    configPath,
  };
}

function loadProjectConfig(cwd) {
  const configPath = findConfigFile(cwd);
  if (!configPath) return { ...DEFAULTS };
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')), configPath);
  } catch {
    return { ...DEFAULTS, configPath };
  }
}

module.exports = { loadProjectConfig, normalizeConfig, findConfigFile, CONFIG_FILE, DEFAULTS, RESUME_MODES, PERMISSION_MODES };
