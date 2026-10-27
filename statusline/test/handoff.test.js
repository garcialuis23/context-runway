'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  evaluateTriggers,
  buildRequestContext,
  buildResumeContext,
  handoffPathFor,
  CONTEXT_THRESHOLD_PCT,
  FIVE_HOUR_THRESHOLD_PCT,
} = require('../src/handoff');

const NOW = 1_800_000_000_000;
const RESETS_AT = NOW / 1000 + 3600; // 5h window resets in an hour (seconds)

// ---------------------------------------------------------------------------
// evaluateTriggers
// ---------------------------------------------------------------------------

test('evaluateTriggers', async (t) => {
  await t.test('does nothing with no history', () => {
    const { reasons, requested } = evaluateTriggers([], 's1', NOW);
    assert.deepEqual(reasons, []);
    assert.deepEqual(requested, {});
  });

  await t.test('does nothing below both thresholds', () => {
    const history = [{ sessionId: 's1', ts: NOW - 1000, contextUsedPct: 50, fiveHourPct: 60, fiveHourResetsAt: RESETS_AT }];
    assert.deepEqual(evaluateTriggers(history, 's1', NOW).reasons, []);
  });

  await t.test('triggers on context at the threshold, using this session only', () => {
    const history = [
      { sessionId: 's1', ts: NOW - 2000, contextUsedPct: CONTEXT_THRESHOLD_PCT },
      { sessionId: 's2', ts: NOW - 1000, contextUsedPct: 10 },
    ];
    const { reasons, requested } = evaluateTriggers(history, 's1', NOW);
    assert.deepEqual(reasons, [{ kind: 'context', pct: CONTEXT_THRESHOLD_PCT }]);
    assert.equal(requested.context, true);
  });

  await t.test("ignores another session's full context", () => {
    const history = [
      { sessionId: 's1', ts: NOW - 2000, contextUsedPct: 10 },
      { sessionId: 's2', ts: NOW - 1000, contextUsedPct: 99 },
    ];
    assert.deepEqual(evaluateTriggers(history, 's1', NOW).reasons, []);
  });

  await t.test('uses the latest sample of the session, not the first', () => {
    const history = [
      { sessionId: 's1', ts: NOW - 1000, contextUsedPct: 90 },
      { sessionId: 's1', ts: NOW - 5000, contextUsedPct: 10 },
    ];
    assert.equal(evaluateTriggers(history, 's1', NOW).reasons[0].kind, 'context');
  });

  await t.test('asks only once for context until usage drops back', () => {
    const full = [{ sessionId: 's1', ts: NOW - 1000, contextUsedPct: 90 }];
    const first = evaluateTriggers(full, 's1', NOW);
    const second = evaluateTriggers(full, 's1', NOW, first.requested);
    assert.deepEqual(second.reasons, []);

    // After a compaction usage drops, which re-arms the trigger.
    const compacted = [{ sessionId: 's1', ts: NOW - 500, contextUsedPct: 20 }];
    const rearmed = evaluateTriggers(compacted, 's1', NOW, second.requested);
    assert.equal(rearmed.requested.context, undefined);
    const third = evaluateTriggers(full.map((e) => ({ ...e, ts: NOW })), 's1', NOW, rearmed.requested);
    assert.equal(third.reasons.length, 1);
  });

  await t.test("triggers on the 5h limit from any session's latest sample", () => {
    const history = [
      { sessionId: 's2', ts: NOW - 2000, fiveHourPct: 50, fiveHourResetsAt: RESETS_AT },
      { sessionId: 's2', ts: NOW - 1000, fiveHourPct: FIVE_HOUR_THRESHOLD_PCT, fiveHourResetsAt: RESETS_AT },
    ];
    const { reasons, requested } = evaluateTriggers(history, 's1', NOW);
    assert.equal(reasons.length, 1);
    assert.equal(reasons[0].kind, 'fiveHour');
    assert.equal(reasons[0].msToReset, 3600 * 1000);
    assert.equal(requested.fiveHour, RESETS_AT);
  });

  await t.test('asks once per 5h window, again in the next one', () => {
    const history = [{ sessionId: 's1', ts: NOW - 1000, fiveHourPct: 97, fiveHourResetsAt: RESETS_AT }];
    const first = evaluateTriggers(history, 's1', NOW);
    assert.deepEqual(evaluateTriggers(history, 's1', NOW, first.requested).reasons, []);

    const nextWindow = [{ sessionId: 's1', ts: NOW, fiveHourPct: 97, fiveHourResetsAt: RESETS_AT + 5 * 3600 }];
    assert.equal(evaluateTriggers(nextWindow, 's1', NOW, first.requested).reasons.length, 1);
  });

  await t.test('ignores a 5h sample whose window has already reset', () => {
    const history = [{ sessionId: 's1', ts: NOW - 1000, fiveHourPct: 99, fiveHourResetsAt: NOW / 1000 - 60 }];
    assert.deepEqual(evaluateTriggers(history, 's1', NOW).reasons, []);
  });

  await t.test('can report both limits at once', () => {
    const history = [
      { sessionId: 's1', ts: NOW - 1000, contextUsedPct: 85, fiveHourPct: 96, fiveHourResetsAt: RESETS_AT },
    ];
    assert.deepEqual(
      evaluateTriggers(history, 's1', NOW).reasons.map((r) => r.kind),
      ['context', 'fiveHour']
    );
  });
});

// ---------------------------------------------------------------------------
// Context text and paths
// ---------------------------------------------------------------------------

test('buildRequestContext names the reasons and the notes path', () => {
  const text = buildRequestContext(
    [
      { kind: 'context', pct: 81.4 },
      { kind: 'fiveHour', pct: 96, msToReset: 90 * 60 * 1000 },
    ],
    '/tmp/notes.md'
  );
  assert.match(text, /context window is 81% full/);
  assert.match(text, /5-hour usage limit is at 96%, resetting in 1h30m/);
  assert.match(text, /\/tmp\/notes\.md/);
  assert.match(text, /## Next steps/);
  assert.ok(text.length < 10000);
});

test('buildResumeContext includes the notes and truncates huge ones under the hook cap', () => {
  const short = buildResumeContext('## Goal\nShip it', '/tmp/n.md', 2 * 60 * 60 * 1000);
  assert.match(short, /2h0m ago/);
  assert.match(short, /## Goal\nShip it/);

  const huge = buildResumeContext('x'.repeat(50000), '/tmp/n.md', 0);
  assert.ok(huge.length < 10000);
  assert.match(huge, /truncated/);
});

test('handoffPathFor is stable per project and distinct across projects', () => {
  const a = handoffPathFor('/home/me/projects/app');
  assert.equal(a, handoffPathFor('/home/me/projects/app'));
  assert.notEqual(a, handoffPathFor('/home/me/other/app'));
  assert.match(path.basename(a), /^app-[0-9a-f]{8}\.md$/);
  assert.ok(!a.includes('\\'));
});

// ---------------------------------------------------------------------------
// End-to-end: run the hook script as Claude Code would, against a temp state
// dir so the real ~/.claude/context-runway is never touched.
// ---------------------------------------------------------------------------

const HANDOFF_PATH = path.join(__dirname, '..', 'src', 'handoff.js');

function runHook(mode, input, stateDir) {
  return spawnSync(process.execPath, [HANDOFF_PATH, mode], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, CONTEXT_RUNWAY_STATE_DIR: stateDir },
    encoding: 'utf8',
  });
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-runway-handoff-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeHistory(dir, entries) {
  fs.writeFileSync(path.join(dir, 'usage-history.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

test('hook exits 0 silently on malformed input or an unknown mode', () => {
  withTempDir((dir) => {
    for (const [mode, input] of [
      ['prompt', '{nope'],
      ['start', ''],
      ['bogus', { session_id: 's1' }],
    ]) {
      const result = runHook(mode, input, dir);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    }
  });
});

test('prompt hook asks for notes once when context is nearly full', () => {
  withTempDir((dir) => {
    writeHistory(dir, [{ sessionId: 's1', ts: Date.now(), contextUsedPct: 88 }]);
    const input = { session_id: 's1', cwd: '/work/app', hook_event_name: 'UserPromptSubmit', prompt: 'hi' };

    const first = runHook('prompt', input, dir);
    assert.equal(first.status, 0);
    const out = JSON.parse(first.stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, 'UserPromptSubmit');
    assert.match(out.additionalContext, /88% full/);
    assert.match(out.additionalContext, /handoffs\/app-[0-9a-f]{8}\.md/);

    assert.equal(runHook('prompt', input, dir).stdout, '');
  });
});

test('prompt hook stays silent with normal usage', () => {
  withTempDir((dir) => {
    writeHistory(dir, [{ sessionId: 's1', ts: Date.now(), contextUsedPct: 30, fiveHourPct: 40 }]);
    const result = runHook('prompt', { session_id: 's1', cwd: '/work/app' }, dir);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });
});

test('start hook delivers fresh notes once, and skips resumed sessions', () => {
  withTempDir((dir) => {
    const cwd = '/work/app';
    const notesPath = handoffPathFor(cwd, path.join(dir, 'handoffs'));

    // No notes yet: nothing to say.
    assert.equal(runHook('start', { session_id: 's2', cwd, source: 'startup' }, dir).stdout, '');

    fs.mkdirSync(path.dirname(notesPath), { recursive: true });
    fs.writeFileSync(notesPath, '## Goal\nFinish the parser\n');

    assert.equal(runHook('start', { session_id: 's2', cwd, source: 'resume' }, dir).stdout, '');

    const delivered = runHook('start', { session_id: 's2', cwd, source: 'startup' }, dir);
    const out = JSON.parse(delivered.stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, 'SessionStart');
    assert.match(out.additionalContext, /Finish the parser/);

    // Same notes, next session: already delivered.
    assert.equal(runHook('start', { session_id: 's3', cwd, source: 'startup' }, dir).stdout, '');

    // Rewritten notes get delivered again.
    const later = new Date(Date.now() + 5000);
    fs.writeFileSync(notesPath, '## Goal\nFinish the lexer\n');
    fs.utimesSync(notesPath, later, later);
    assert.match(runHook('start', { session_id: 's4', cwd, source: 'clear' }, dir).stdout, /Finish the lexer/);
  });
});

test('start hook ignores notes older than a week', () => {
  withTempDir((dir) => {
    const cwd = '/work/old';
    const notesPath = handoffPathFor(cwd, path.join(dir, 'handoffs'));

    fs.mkdirSync(path.dirname(notesPath), { recursive: true });
    fs.writeFileSync(notesPath, 'stale');
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(notesPath, old, old);
    assert.equal(runHook('start', { session_id: 's2', cwd, source: 'startup' }, dir).stdout, '');
  });
});
