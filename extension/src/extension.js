'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { readHistory, HISTORY_FILE, STATE_DIR } = require('./historyReader');
const { renderPanelHtml, getNonce } = require('./panel');

let statusBarItem;
let panel;
let watcher;
let pollTimer;

function backgroundForPct(pct) {
  if (pct >= 90) return new vscode.ThemeColor('statusBarItem.errorBackground');
  if (pct >= 70) return new vscode.ThemeColor('statusBarItem.warningBackground');
  return undefined;
}

function refresh() {
  const history = readHistory();
  const latest = history.length ? history[history.length - 1] : null;

  if (!latest) {
    statusBarItem.text = '$(pulse) context-runway: no data';
    statusBarItem.tooltip = `No usage data found at ${HISTORY_FILE}.\nInstall the context-runway statusline first (see statusline/README.md), then keep using Claude Code.`;
    statusBarItem.backgroundColor = undefined;
    statusBarItem.show();
    if (panel) panel.webview.postMessage({ type: 'history', history: [] });
    return;
  }

  const parts = [];
  if (typeof latest.contextUsedPct === 'number') parts.push(`ctx ${latest.contextUsedPct.toFixed(0)}%`);
  if (typeof latest.fiveHourPct === 'number') parts.push(`5h ${latest.fiveHourPct.toFixed(0)}%`);
  if (typeof latest.sevenDayPct === 'number') parts.push(`7d ${latest.sevenDayPct.toFixed(0)}%`);

  const worstPct = Math.max(latest.contextUsedPct || 0, latest.fiveHourPct || 0, latest.sevenDayPct || 0);

  statusBarItem.text = `$(pulse) ${parts.length ? parts.join(' · ') : 'context-runway'}`;
  statusBarItem.tooltip = 'Click for context & rate-limit history — Context Runway';
  statusBarItem.backgroundColor = backgroundForPct(worstPct);
  statusBarItem.show();

  if (panel) panel.webview.postMessage({ type: 'history', history });
}

function showPanel() {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside);
    refresh();
    return;
  }

  panel = vscode.window.createWebviewPanel('contextRunway', 'Context Runway', vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.webview.html = renderPanelHtml(getNonce());
  panel.onDidDispose(() => {
    panel = undefined;
  });
  refresh();
}

function activate(context) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'context-runway.showPanel';
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(vscode.commands.registerCommand('context-runway.showPanel', showPanel));

  refresh();

  // Live-updates when the statusline script (../../statusline) appends a
  // new snapshot. The state dir may not exist yet if the statusline has
  // never run once — the poll fallback below covers that case.
  try {
    watcher = fs.watch(STATE_DIR, { persistent: false }, (_event, filename) => {
      if (!filename || filename === path.basename(HISTORY_FILE)) refresh();
    });
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch {
    // STATE_DIR doesn't exist yet; polling picks it up once it's created.
  }

  pollTimer = setInterval(refresh, 30000);
  context.subscriptions.push({ dispose: () => clearInterval(pollTimer) });
}

function deactivate() {}

module.exports = { activate, deactivate };
