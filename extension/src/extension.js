'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const {
  readHistory,
  mostRecentWithField,
  sessionLabel,
  formatTokenCount,
  HISTORY_FILE,
  STATE_DIR,
} = require('./historyReader');
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

// Name of the workspace folder this VS Code window has open, so the status
// bar's "ctx" figure can prefer a session in *this* project over whichever
// session anywhere last happened to write (see mostRecentContextEntry).
function currentWorkspaceDir() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? path.basename(folder.uri.fsPath) : null;
}

function mostRecentContextEntry(history, workspaceDir) {
  if (workspaceDir) {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].dir === workspaceDir && typeof history[i].contextUsedPct === 'number') return history[i];
    }
  }
  return mostRecentWithField(history, 'contextUsedPct');
}

function refresh() {
  const history = readHistory();
  const workspaceDir = currentWorkspaceDir();

  if (history.length === 0) {
    statusBarItem.text = '$(pulse) context-runway: no data';
    statusBarItem.tooltip = `No usage data found at ${HISTORY_FILE}.\nInstall the context-runway statusline first (see statusline/README.md), then keep using Claude Code.`;
    statusBarItem.backgroundColor = undefined;
    statusBarItem.show();
    if (panel) panel.webview.postMessage({ type: 'history', history: [], workspaceDir });
    return;
  }

  // Each metric independently uses the most recent entry that actually has
  // it, rather than blindly trusting history[history.length - 1] — with
  // multiple concurrent sessions, the very last write can come from a
  // brand-new session still missing rate_limits, which would otherwise blank
  // out perfectly good, more recent numbers from another session.
  const ctxEntry = mostRecentContextEntry(history, workspaceDir);
  const fiveHourEntry = mostRecentWithField(history, 'fiveHourPct');
  const sevenDayEntry = mostRecentWithField(history, 'sevenDayPct');

  const parts = [];
  if (ctxEntry) parts.push(`ctx ${ctxEntry.contextUsedPct.toFixed(0)}%`);
  if (fiveHourEntry) parts.push(`5h ${fiveHourEntry.fiveHourPct.toFixed(0)}%`);
  if (sevenDayEntry) parts.push(`7d ${sevenDayEntry.sevenDayPct.toFixed(0)}%`);

  const worstPct = Math.max(
    ctxEntry?.contextUsedPct || 0,
    fiveHourEntry?.fiveHourPct || 0,
    sevenDayEntry?.sevenDayPct || 0
  );

  statusBarItem.text = `$(pulse) ${parts.length ? parts.join(' · ') : 'context-runway'}`;
  if (ctxEntry) {
    const modelMeta = [ctxEntry.model, formatTokenCount(ctxEntry.contextWindowSize), ctxEntry.effortLevel]
      .filter(Boolean)
      .join(' · ');
    statusBarItem.tooltip = `${sessionLabel(ctxEntry)}${modelMeta ? ` (${modelMeta})` : ''}\nClick for context & rate-limit history — Context Runway`;
  } else {
    statusBarItem.tooltip = 'Click for context & rate-limit history — Context Runway';
  }
  statusBarItem.backgroundColor = backgroundForPct(worstPct);
  statusBarItem.show();

  if (panel) panel.webview.postMessage({ type: 'history', history, workspaceDir });
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
