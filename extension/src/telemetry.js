'use strict';

const vscode = require('vscode');

// Gated by two independent switches, both required: VS Code's own global
// kill-switch (telemetry.telemetryLevel, surfaced here as isTelemetryEnabled)
// and our own opt-in setting, which defaults to off. Neither switch alone
// is enough to send anything.
function isEnabled() {
  const ownSetting = vscode.workspace.getConfiguration('context-runway').get('telemetry.enabled', false);
  return vscode.env.isTelemetryEnabled && ownSetting;
}

// No collector is wired up yet — this is a no-op until a real backend
// (e.g. Application Insights, a custom endpoint) is plugged in here. Callers
// should still call it at the point of interest so enabling a backend later
// doesn't require touching call sites.
function sendEvent(name, properties) {
  if (!isEnabled()) return;
}

module.exports = { isEnabled, sendEvent };
