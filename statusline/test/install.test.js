'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installHandoffHooks, withoutHandoffHooks, isHandoffHook } = require('../src/install');

const otherHook = { type: 'command', command: 'echo unrelated' };

function handoffCommands(settings, event) {
  return (settings.hooks[event] || []).flatMap((g) => g.hooks).filter(isHandoffHook).map((h) => h.command);
}

test('installHandoffHooks adds every hook to empty settings', () => {
  const settings = {};
  installHandoffHooks(settings);

  const [prompt] = handoffCommands(settings, 'UserPromptSubmit');
  const [tool] = handoffCommands(settings, 'PostToolUse');
  const [start] = handoffCommands(settings, 'SessionStart');
  const [stopfail] = handoffCommands(settings, 'StopFailure');
  assert.match(prompt, /handoff\.js" prompt$/);
  assert.match(tool, /handoff\.js" tool$/);
  assert.match(start, /handoff\.js" start$/);
  assert.match(stopfail, /handoff\.js" stopfail$/);
  assert.equal(settings.hooks.SessionStart[0].matcher, 'startup|clear|compact');
  assert.equal(settings.hooks.StopFailure[0].matcher, 'rate_limit');
  assert.equal(settings.hooks.UserPromptSubmit[0].matcher, undefined);
  assert.equal(settings.hooks.PostToolUse[0].matcher, undefined);
  // Long enough for PowerShell to register the scheduled task (it gives up at 20s).
  assert.equal(settings.hooks.StopFailure[0].hooks[0].timeout, 30);
  assert.equal(settings.hooks.PostToolUse[0].hooks[0].timeout, 10);
});

test('installHandoffHooks is idempotent', () => {
  const settings = {};
  installHandoffHooks(settings);
  installHandoffHooks(settings);
  for (const event of ['UserPromptSubmit', 'PostToolUse', 'SessionStart', 'StopFailure']) {
    assert.equal(handoffCommands(settings, event).length, 1, event);
  }
});

test("installHandoffHooks keeps the user's own hooks", () => {
  const settings = {
    hooks: {
      UserPromptSubmit: [{ hooks: [otherHook] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [otherHook] }],
    },
  };
  installHandoffHooks(settings);
  assert.deepEqual(settings.hooks.UserPromptSubmit[0], { hooks: [otherHook] });
  assert.deepEqual(settings.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [otherHook] }]);
  assert.equal(handoffCommands(settings, 'UserPromptSubmit').length, 1);
});

test('withoutHandoffHooks removes only ours, dropping groups and events left empty', () => {
  const settings = { hooks: { UserPromptSubmit: [{ hooks: [otherHook] }] } };
  installHandoffHooks(settings);

  const cleaned = withoutHandoffHooks(settings.hooks);
  assert.deepEqual(cleaned, { UserPromptSubmit: [{ hooks: [otherHook] }] });
});
