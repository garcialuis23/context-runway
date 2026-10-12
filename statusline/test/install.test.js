'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installHandoffHooks, withoutHandoffHooks, isHandoffHook } = require('../src/install');

const otherHook = { type: 'command', command: 'echo unrelated' };

function handoffCommands(settings, event) {
  return (settings.hooks[event] || []).flatMap((g) => g.hooks).filter(isHandoffHook).map((h) => h.command);
}

test('installHandoffHooks adds both hooks to empty settings', () => {
  const settings = {};
  installHandoffHooks(settings);

  const [prompt] = handoffCommands(settings, 'UserPromptSubmit');
  const [start] = handoffCommands(settings, 'SessionStart');
  assert.match(prompt, /handoff\.js" prompt$/);
  assert.match(start, /handoff\.js" start$/);
  assert.equal(settings.hooks.SessionStart[0].matcher, 'startup|clear|compact');
  assert.equal(settings.hooks.UserPromptSubmit[0].matcher, undefined);
});

test('installHandoffHooks is idempotent', () => {
  const settings = {};
  installHandoffHooks(settings);
  installHandoffHooks(settings);
  assert.equal(handoffCommands(settings, 'UserPromptSubmit').length, 1);
  assert.equal(handoffCommands(settings, 'SessionStart').length, 1);
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
