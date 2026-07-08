'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vscodeMockLib = require('../test-mocks/vscode');

function loadTelemetry(mock) {
  vscodeMockLib.install(mock);
  const telemetryPath = require.resolve('../src/telemetry');
  delete require.cache[telemetryPath];
  return require(telemetryPath);
}

test('isEnabled: false when both VS Code telemetry and the own setting are off (the defaults)', (t) => {
  const mock = vscodeMockLib.createVscodeMock();
  const telemetry = loadTelemetry(mock);
  t.after(() => vscodeMockLib.uninstall());

  assert.equal(telemetry.isEnabled(), false);
});

test('isEnabled: false when VS Code telemetry is off, even if our own setting is on', (t) => {
  const mock = vscodeMockLib.createVscodeMock();
  mock.vscode.env.isTelemetryEnabled = false;
  mock.setConfig('context-runway.telemetry.enabled', true);
  const telemetry = loadTelemetry(mock);
  t.after(() => vscodeMockLib.uninstall());

  assert.equal(telemetry.isEnabled(), false);
});

test('isEnabled: false when our own setting is off, even if VS Code telemetry is on', (t) => {
  const mock = vscodeMockLib.createVscodeMock();
  mock.vscode.env.isTelemetryEnabled = true;
  const telemetry = loadTelemetry(mock);
  t.after(() => vscodeMockLib.uninstall());

  assert.equal(telemetry.isEnabled(), false);
});

test('isEnabled: true only once both VS Code telemetry and the own setting are on', (t) => {
  const mock = vscodeMockLib.createVscodeMock();
  mock.vscode.env.isTelemetryEnabled = true;
  mock.setConfig('context-runway.telemetry.enabled', true);
  const telemetry = loadTelemetry(mock);
  t.after(() => vscodeMockLib.uninstall());

  assert.equal(telemetry.isEnabled(), true);
});

test('sendEvent: never throws, on or off', (t) => {
  const mock = vscodeMockLib.createVscodeMock();
  mock.vscode.env.isTelemetryEnabled = true;
  mock.setConfig('context-runway.telemetry.enabled', true);
  const telemetry = loadTelemetry(mock);
  t.after(() => vscodeMockLib.uninstall());

  assert.doesNotThrow(() => telemetry.sendEvent('showPanel'));
});
