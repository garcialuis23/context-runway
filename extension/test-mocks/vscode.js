'use strict';

// A minimal stand-in for the 'vscode' module so extension.js can be required
// and exercised under plain Node (no @vscode/test-electron / extension
// host needed). Installed by patching Module._load to intercept
// require('vscode') — the standard technique for this since 'vscode' isn't
// a real resolvable package outside the extension host.

const Module = require('module');

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

function createVscodeMock() {
  const statusBarItem = {
    text: '',
    tooltip: '',
    backgroundColor: undefined,
    command: undefined,
    shown: false,
    disposed: false,
    show() {
      this.shown = true;
    },
    hide() {
      this.shown = false;
    },
    dispose() {
      this.disposed = true;
    },
  };

  const registeredCommands = new Map();
  const webviewPanels = [];
  const openTextDocumentCalls = [];
  const showTextDocumentCalls = [];
  const showWarningMessageCalls = [];
  const showInformationMessageCalls = [];
  const showErrorMessageCalls = [];

  // Configurable per test: what the "clear history?" confirmation resolves to.
  let showWarningMessageResolution;

  function createWebviewPanel(viewType, title, showOptions) {
    const panel = {
      viewType,
      title,
      showOptions,
      webview: {
        html: '',
        messages: [],
        postMessage(message) {
          this.messages.push(message);
          return Promise.resolve(true);
        },
      },
      disposed: false,
      _disposeHandlers: [],
      onDidDispose(handler) {
        this._disposeHandlers.push(handler);
      },
      reveal() {},
      dispose() {
        this.disposed = true;
        this._disposeHandlers.forEach((h) => h());
      },
    };
    webviewPanels.push(panel);
    return panel;
  }

  const vscode = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1, Beside: -2, One: 1 },
    ThemeColor,
    window: {
      createStatusBarItem: () => statusBarItem,
      createWebviewPanel: (...args) => createWebviewPanel(...args),
      showWarningMessage: async (...args) => {
        showWarningMessageCalls.push(args);
        return typeof showWarningMessageResolution === 'function'
          ? showWarningMessageResolution(...args)
          : showWarningMessageResolution;
      },
      showInformationMessage: async (...args) => {
        showInformationMessageCalls.push(args);
      },
      showErrorMessage: async (...args) => {
        showErrorMessageCalls.push(args);
      },
      showTextDocument: async (...args) => {
        showTextDocumentCalls.push(args);
      },
    },
    workspace: {
      workspaceFolders: undefined,
      openTextDocument: async (uriOrPath) => {
        openTextDocumentCalls.push(uriOrPath);
        return { uri: uriOrPath };
      },
    },
    commands: {
      registerCommand: (id, handler) => {
        registeredCommands.set(id, handler);
        return {
          dispose() {
            registeredCommands.delete(id);
          },
        };
      },
    },
  };

  return {
    vscode,
    statusBarItem,
    registeredCommands,
    webviewPanels,
    openTextDocumentCalls,
    showTextDocumentCalls,
    showWarningMessageCalls,
    showInformationMessageCalls,
    showErrorMessageCalls,
    setShowWarningMessageResolution(value) {
      showWarningMessageResolution = value;
    },
  };
}

let originalLoad = null;
let activeMock = null;

function install(mock) {
  activeMock = mock;
  if (originalLoad) return; // Module._load is already patched from an earlier install().
  originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return activeMock.vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
}

function uninstall() {
  if (originalLoad) {
    Module._load = originalLoad;
    originalLoad = null;
  }
  activeMock = null;
}

module.exports = { createVscodeMock, install, uninstall };
