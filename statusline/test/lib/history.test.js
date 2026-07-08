'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// history.js reads CONTEXT_RUNWAY_STATE_DIR once at module-load time, so each
// test gets a throwaway temp dir and a fresh require (cache busted) to stay
// isolated from every other test and from the user's real ~/.claude state.
function loadHistoryModule(stateDir) {
  const modPath = require.resolve('../../src/lib/history');
  delete require.cache[modPath];
  process.env.CONTEXT_RUNWAY_STATE_DIR = stateDir;
  return require(modPath);
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-runway-history-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('readHistory returns [] when the history file does not exist', () => {
  withTempDir((dir) => {
    const { readHistory } = loadHistoryModule(dir);
    assert.deepEqual(readHistory(), []);
  });
});

test('readHistory returns [] for an empty file', () => {
  withTempDir((dir) => {
    const { readHistory, HISTORY_FILE } = loadHistoryModule(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, '');
    assert.deepEqual(readHistory(), []);
  });
});

test('readHistory skips malformed JSON lines but keeps valid ones', () => {
  withTempDir((dir) => {
    const { readHistory, HISTORY_FILE } = loadHistoryModule(dir);
    const lines = [
      JSON.stringify({ ts: 1, sessionId: 'a' }),
      'not json at all {{{',
      JSON.stringify({ ts: 2, sessionId: 'b' }),
      '', // blank lines (trailing newline artifacts) are filtered out too
    ];
    fs.writeFileSync(HISTORY_FILE, lines.join('\n') + '\n');

    const result = readHistory();
    assert.equal(result.length, 2);
    assert.equal(result[0].sessionId, 'a');
    assert.equal(result[1].sessionId, 'b');
  });
});

test('appendSnapshot creates the state dir and file on first write', () => {
  withTempDir((dir) => {
    const { appendSnapshot, HISTORY_FILE } = loadHistoryModule(dir);
    const snapshot = { ts: 1000, sessionId: 's1', contextUsedPct: 10 };
    const result = appendSnapshot(snapshot);

    assert.deepEqual(result, [snapshot]);
    assert.ok(fs.existsSync(HISTORY_FILE));
    const onDisk = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(onDisk, [snapshot]);
  });
});

test('appendSnapshot throttles same-session writes within MIN_SAMPLE_INTERVAL_MS', () => {
  withTempDir((dir) => {
    const { appendSnapshot, HISTORY_FILE } = loadHistoryModule(dir);
    appendSnapshot({ ts: 1000, sessionId: 's1', contextUsedPct: 10 });
    const result = appendSnapshot({ ts: 1000 + 5000, sessionId: 's1', contextUsedPct: 20 });

    // Still within the 20s throttle window: second sample must be dropped.
    assert.equal(result.length, 1);
    assert.equal(result[0].contextUsedPct, 10);
    const onDisk = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n');
    assert.equal(onDisk.length, 1);
  });
});

test('appendSnapshot does not throttle once MIN_SAMPLE_INTERVAL_MS has elapsed', () => {
  withTempDir((dir) => {
    const { appendSnapshot } = loadHistoryModule(dir);
    appendSnapshot({ ts: 1000, sessionId: 's1', contextUsedPct: 10 });
    const result = appendSnapshot({ ts: 1000 + 21_000, sessionId: 's1', contextUsedPct: 20 });

    assert.equal(result.length, 2);
    assert.equal(result[1].contextUsedPct, 20);
  });
});

test('appendSnapshot never throttles across different sessions', () => {
  withTempDir((dir) => {
    const { appendSnapshot } = loadHistoryModule(dir);
    appendSnapshot({ ts: 1000, sessionId: 's1', contextUsedPct: 10 });
    const result = appendSnapshot({ ts: 1001, sessionId: 's2', contextUsedPct: 20 });

    assert.equal(result.length, 2);
  });
});

test('appendSnapshot prunes stale entries when the dice roll hits', (t) => {
  withTempDir((dir) => {
    const { appendSnapshot, HISTORY_FILE } = loadHistoryModule(dir);
    const MAX_AGE_MS = 9 * 24 * 60 * 60 * 1000;
    const staleTs = 0;
    const freshTs = staleTs + MAX_AGE_MS + 30_000; // just barely stale relative to freshTs

    appendSnapshot({ ts: staleTs, sessionId: 's1', contextUsedPct: 1 });

    const originalRandom = Math.random;
    Math.random = () => 0; // forces PRUNE_CHANCE (0.05) to trigger
    t.after(() => {
      Math.random = originalRandom;
    });

    const result = appendSnapshot({ ts: freshTs, sessionId: 's2', contextUsedPct: 2 });

    assert.equal(result.length, 1);
    assert.equal(result[0].sessionId, 's2');
    const onDisk = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0].sessionId, 's2');
  });
});

test('appendSnapshot keeps stale entries when the dice roll misses', (t) => {
  withTempDir((dir) => {
    const { appendSnapshot } = loadHistoryModule(dir);
    const MAX_AGE_MS = 9 * 24 * 60 * 60 * 1000;
    const staleTs = 0;
    const freshTs = staleTs + MAX_AGE_MS + 30_000;

    appendSnapshot({ ts: staleTs, sessionId: 's1', contextUsedPct: 1 });

    const originalRandom = Math.random;
    Math.random = () => 0.99; // PRUNE_CHANCE (0.05) never triggers
    t.after(() => {
      Math.random = originalRandom;
    });

    const result = appendSnapshot({ ts: freshTs, sessionId: 's2', contextUsedPct: 2 });

    // Nothing pruned this round: both the old and new entries are still present.
    assert.equal(result.length, 2);
  });
});

test('appendSnapshot never prunes when nothing is actually stale', (t) => {
  withTempDir((dir) => {
    const { appendSnapshot } = loadHistoryModule(dir);
    appendSnapshot({ ts: 1000, sessionId: 's1', contextUsedPct: 1 });

    const originalRandom = Math.random;
    Math.random = () => 0; // would force a prune *if* hasStale were true
    t.after(() => {
      Math.random = originalRandom;
    });

    const result = appendSnapshot({ ts: 1000 + 21_000, sessionId: 's1', contextUsedPct: 2 });
    assert.equal(result.length, 2);
  });
});
