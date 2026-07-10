'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscodeMockLib = require('../test-mocks/vscode');

// extension.js keeps module-scoped state (statusBarItem, panel, watcher,
// pollTimer), so every test needs a fresh require (cache busted) plus a
// fresh vscode mock and a throwaway CONTEXT_RUNWAY_STATE_DIR — otherwise
// tests would leak state into each other and real timers/watchers would pile
// up across the whole run.
function loadExtension(stateDir, mock) {
  vscodeMockLib.install(mock);
  process.env.CONTEXT_RUNWAY_STATE_DIR = stateDir;
  const extPath = require.resolve('../src/extension');
  const historyReaderPath = require.resolve('../src/historyReader');
  const panelPath = require.resolve('../src/panel');
  delete require.cache[extPath];
  delete require.cache[historyReaderPath];
  delete require.cache[panelPath];
  return require(extPath);
}

function writeHistory(dir, entries) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'usage-history.jsonl');
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
}

// Activates a fresh extension instance against `entries` (omit to leave the
// state dir with no history file at all, as opposed to an empty one).
function setup(entries, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-runway-ext-test-'));
  if (entries) writeHistory(dir, entries);
  else fs.mkdirSync(dir, { recursive: true });

  const mock = vscodeMockLib.createVscodeMock();
  if (opts.workspaceDir) {
    mock.vscode.workspace.workspaceFolders = [{ uri: { fsPath: `/workspace/${opts.workspaceDir}` } }];
  }

  const extension = loadExtension(dir, mock);
  const context = { subscriptions: [] };
  extension.activate(context);

  return {
    dir,
    mock,
    context,
    extension,
    historyFile: path.join(dir, 'usage-history.jsonl'),
    cleanup() {
      context.subscriptions.forEach((d) => d.dispose());
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('activate: with no usage history shows a "no data" status', (t) => {
  const env = setup([]);
  t.after(() => env.cleanup());

  assert.equal(env.mock.statusBarItem.text, '$(pulse) context-runway: no data');
  assert.match(env.mock.statusBarItem.tooltip, /No usage data found/);
  assert.equal(env.mock.statusBarItem.backgroundColor, undefined);
  assert.equal(env.mock.statusBarItem.shown, true);
});

test('activate: tolerates a STATE_DIR that does not exist yet', (t) => {
  const dir = path.join(os.tmpdir(), `context-runway-ext-missing-${Date.now()}`);
  const mock = vscodeMockLib.createVscodeMock();
  const extension = loadExtension(dir, mock);
  const context = { subscriptions: [] };

  assert.doesNotThrow(() => extension.activate(context));
  assert.equal(mock.statusBarItem.text, '$(pulse) context-runway: no data');

  t.after(() => context.subscriptions.forEach((d) => d.dispose()));
});

test('activate: renders ctx/5h/7d percentages from the most recent samples', (t) => {
  const now = Date.now();
  const env = setup([
    {
      ts: now,
      sessionId: 's1',
      dir: 'myproj',
      model: 'Sonnet',
      contextUsedPct: 42,
      contextWindowSize: 200000,
      fiveHourPct: 20,
      fiveHourResetsAt: Math.floor(now / 1000) + 3600,
      sevenDayPct: 30,
      sevenDayResetsAt: Math.floor(now / 1000) + 86400,
    },
  ]);
  t.after(() => env.cleanup());

  assert.match(env.mock.statusBarItem.text, /ctx 42%/);
  assert.match(env.mock.statusBarItem.text, /5h 20%/);
  assert.match(env.mock.statusBarItem.text, /7d 30%/);
  assert.equal(env.mock.statusBarItem.backgroundColor, undefined); // worst pct 42 < 70
});

test('activate: background color turns to warning at 70% and error at 90%', (t) => {
  const now = Date.now();
  const warn = setup([{ ts: now, sessionId: 's1', contextUsedPct: 75 }]);
  t.after(() => warn.cleanup());
  assert.ok(warn.mock.statusBarItem.backgroundColor instanceof warn.mock.vscode.ThemeColor);
  assert.equal(warn.mock.statusBarItem.backgroundColor.id, 'statusBarItem.warningBackground');

  const error = setup([{ ts: now, sessionId: 's1', contextUsedPct: 95 }]);
  t.after(() => error.cleanup());
  assert.equal(error.mock.statusBarItem.backgroundColor.id, 'statusBarItem.errorBackground');
});

test('activate: prefers the current workspace session over a more recent one elsewhere', (t) => {
  const now = Date.now();
  const env = setup(
    [
      { ts: now - 1000, sessionId: 's1', dir: 'myproj', contextUsedPct: 30 },
      { ts: now, sessionId: 's2', dir: 'otherproj', contextUsedPct: 80 }, // newer, but a different project
    ],
    { workspaceDir: 'myproj' }
  );
  t.after(() => env.cleanup());

  assert.match(env.mock.statusBarItem.text, /ctx 30%/);
  assert.ok(!env.mock.statusBarItem.text.includes('80%'));
});

test('activate: falls back to the most recent session anywhere with no matching workspace', (t) => {
  const now = Date.now();
  const env = setup([
    { ts: now - 1000, sessionId: 's1', dir: 'myproj', contextUsedPct: 30 },
    { ts: now, sessionId: 's2', dir: 'otherproj', contextUsedPct: 80 },
  ]); // no workspaceDir configured
  t.after(() => env.cleanup());

  assert.match(env.mock.statusBarItem.text, /ctx 80%/);
});

test('activate: does not show a different project\'s % for a brand-new project with no samples yet', (t) => {
  const now = Date.now();
  const env = setup(
    [
      { ts: now - 1000, sessionId: 's1', dir: 'myproj', contextUsedPct: 30 },
      { ts: now, sessionId: 's2', dir: 'otherproj', contextUsedPct: 80 },
    ],
    { workspaceDir: 'brand-new-project' }
  );
  t.after(() => env.cleanup());

  assert.ok(!env.mock.statusBarItem.text.includes('ctx'));
  assert.ok(!env.mock.statusBarItem.text.includes('30%'));
  assert.ok(!env.mock.statusBarItem.text.includes('80%'));
});

test('activate: shows -- and a warning for an expired rate-limit window instead of a stale %', (t) => {
  const now = Date.now();
  const env = setup([
    {
      ts: now,
      sessionId: 's1',
      fiveHourPct: 50,
      fiveHourResetsAt: Math.floor((now - 60_000) / 1000), // already in the past
      sevenDayPct: 60,
      sevenDayResetsAt: Math.floor(now / 1000) + 86400,
    },
  ]);
  t.after(() => env.cleanup());

  assert.match(env.mock.statusBarItem.text, /5h --/);
  assert.ok(!env.mock.statusBarItem.text.includes('50%'));
  assert.match(env.mock.statusBarItem.text, /7d 60%/);
  assert.match(env.mock.statusBarItem.tooltip, /Rate-limit window\(s\) have reset/);
});

test('activate: tooltip stays quiet about sourcing when ctx and rate limits share one session', (t) => {
  const now = Date.now();
  const env = setup([
    {
      ts: now,
      sessionId: 's1',
      dir: 'myproj',
      contextUsedPct: 42,
      fiveHourPct: 20,
      fiveHourResetsAt: Math.floor(now / 1000) + 3600,
      sevenDayPct: 30,
      sevenDayResetsAt: Math.floor(now / 1000) + 86400,
    },
  ]);
  t.after(() => env.cleanup());

  assert.ok(!env.mock.statusBarItem.tooltip.includes('5h from'));
  assert.ok(!env.mock.statusBarItem.tooltip.includes('7d from'));
});

test('activate: tooltip credits the session actually feeding 5h/7d when it differs from the ctx session', (t) => {
  const now = Date.now();
  const env = setup(
    [
      // A terminal session in another project, still within both windows.
      {
        ts: now - 60_000,
        sessionId: 'terminal-session',
        dir: 'other-repo',
        fiveHourPct: 55,
        fiveHourResetsAt: Math.floor(now / 1000) + 3600,
        sevenDayPct: 65,
        sevenDayResetsAt: Math.floor(now / 1000) + 86400,
      },
      // The VS Code chat session for the current workspace: only reports ctx.
      { ts: now, sessionId: 'vscode-session', dir: 'myproj', contextUsedPct: 10 },
    ],
    { workspaceDir: 'myproj' }
  );
  t.after(() => env.cleanup());

  assert.match(env.mock.statusBarItem.text, /5h 55%/);
  assert.match(env.mock.statusBarItem.text, /7d 65%/);
  assert.match(env.mock.statusBarItem.tooltip, /5h from other-repo · #termin, updated/);
  assert.match(env.mock.statusBarItem.tooltip, /7d from other-repo · #termin, updated/);
});

test('clearHistory: confirming wipes the file and shows a confirmation message', async (t) => {
  const env = setup([{ ts: Date.now(), sessionId: 's1', contextUsedPct: 10 }]);
  t.after(() => env.cleanup());
  env.mock.setShowWarningMessageResolution('Clear History');

  const handler = env.mock.registeredCommands.get('context-runway.clearHistory');
  assert.ok(handler, 'clearHistory command should be registered');
  await handler();

  assert.equal(fs.readFileSync(env.historyFile, 'utf8'), '');
  assert.equal(env.mock.showInformationMessageCalls.length, 1);
  assert.match(env.mock.showInformationMessageCalls[0][0], /cleared/i);
});

test('clearHistory: dismissing the confirmation leaves the file untouched', async (t) => {
  const env = setup([{ ts: Date.now(), sessionId: 's1', contextUsedPct: 10 }]);
  t.after(() => env.cleanup());
  env.mock.setShowWarningMessageResolution(undefined); // user dismissed the modal

  const before = fs.readFileSync(env.historyFile, 'utf8');
  const handler = env.mock.registeredCommands.get('context-runway.clearHistory');
  await handler();

  assert.equal(fs.readFileSync(env.historyFile, 'utf8'), before);
  assert.equal(env.mock.showInformationMessageCalls.length, 0);
});

test('openRawLog: shows an informational message and does not open a document when no history exists yet', async (t) => {
  const env = setup(); // no history file at all
  t.after(() => env.cleanup());

  const handler = env.mock.registeredCommands.get('context-runway.openRawLog');
  await handler();

  assert.equal(env.mock.openTextDocumentCalls.length, 0);
  assert.equal(env.mock.showInformationMessageCalls.length, 1);
});

test('openRawLog: opens the history file as a text document when it exists', async (t) => {
  const env = setup([{ ts: Date.now(), sessionId: 's1', contextUsedPct: 10 }]);
  t.after(() => env.cleanup());

  const handler = env.mock.registeredCommands.get('context-runway.openRawLog');
  await handler();

  assert.equal(env.mock.openTextDocumentCalls.length, 1);
  assert.equal(env.mock.openTextDocumentCalls[0], env.historyFile);
  assert.equal(env.mock.showTextDocumentCalls.length, 1);
});

test('showPanel: creates a panel once, posting the current history, and reveals it on subsequent calls', (t) => {
  const env = setup([{ ts: Date.now(), sessionId: 's1', contextUsedPct: 10 }]);
  t.after(() => env.cleanup());

  const handler = env.mock.registeredCommands.get('context-runway.showPanel');
  handler();

  assert.equal(env.mock.webviewPanels.length, 1);
  const panel = env.mock.webviewPanels[0];
  assert.match(panel.webview.html, /Context Runway/);
  assert.equal(panel.webview.messages.length, 1);
  assert.equal(panel.webview.messages[0].type, 'history');
  assert.equal(panel.webview.messages[0].history.length, 1);

  handler(); // second call: reveal + refresh, not a new panel
  assert.equal(env.mock.webviewPanels.length, 1);
  assert.equal(panel.webview.messages.length, 2);
});

test('showPanel: opens a fresh panel again after the previous one was disposed', (t) => {
  const env = setup([{ ts: Date.now(), sessionId: 's1', contextUsedPct: 10 }]);
  t.after(() => env.cleanup());

  const handler = env.mock.registeredCommands.get('context-runway.showPanel');
  handler();
  assert.equal(env.mock.webviewPanels.length, 1);

  env.mock.webviewPanels[0].dispose();
  handler();
  assert.equal(env.mock.webviewPanels.length, 2);
});

test('activate: disposing context.subscriptions tears down the status bar item and commands cleanly', (t) => {
  const env = setup([]);
  assert.equal(env.mock.registeredCommands.size, 3);

  assert.doesNotThrow(() => env.context.subscriptions.forEach((d) => d.dispose()));

  assert.equal(env.mock.statusBarItem.disposed, true);
  assert.equal(env.mock.registeredCommands.size, 0);

  t.after(() => fs.rmSync(env.dir, { recursive: true, force: true }));
});
