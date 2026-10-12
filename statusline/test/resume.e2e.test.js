'use strict';

// End-to-end: PostToolUse, project config, and resuming after a usage limit.
// Runs handoff.js as Claude Code / Task Scheduler would, against a temp state
// dir, with the scheduler in dry-run mode and a fake claude CLI, so nothing
// real is scheduled or launched.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { projectSlug } = require('../src/lib/project');

const HANDOFF_PATH = path.join(__dirname, '..', 'src', 'handoff.js');

function runScript(args, { input = '', stateDir, env = {} }) {
  return spawnSync(process.execPath, [HANDOFF_PATH, ...args], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, CONTEXT_RUNWAY_STATE_DIR: stateDir, ...env },
    encoding: 'utf8',
  });
}

const hookOutput = (result) => JSON.parse(result.stdout).hookSpecificOutput;

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-runway-resume-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeHistory(dir, entries) {
  fs.writeFileSync(path.join(dir, 'usage-history.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

// A project folder with an optional .context-runway.json, inside the temp dir.
function makeProject(dir, handoff) {
  const cwd = path.join(dir, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  if (handoff) fs.writeFileSync(path.join(cwd, '.context-runway.json'), JSON.stringify({ handoff }));
  return cwd;
}

// Stands in for the claude CLI: records its arguments, prints what --bg prints.
function makeFakeClaude(dir) {
  const file = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(
    file,
    `require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'claude-args.json'))}, JSON.stringify(process.argv.slice(2)));\n` +
      "console.log('backgrounded \\u00b7 abc12345');\n"
  );
  return file;
}

function testEnv(dir) {
  return {
    CONTEXT_RUNWAY_SCHEDULER_DRYRUN: path.join(dir, 'scheduler.jsonl'),
    CONTEXT_RUNWAY_CLAUDE_BIN: makeFakeClaude(dir),
  };
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function resumeFiles(dir, cwd) {
  const slug = projectSlug(cwd);
  return {
    plan: path.join(dir, 'resume', `${slug}.json`),
    script: path.join(dir, 'resume', `${slug}${process.platform === 'win32' ? '.cmd' : '.sh'}`),
    log: path.join(dir, 'resume-log.jsonl'),
  };
}

const inOneHour = () => Date.now() / 1000 + 3600;

test('tool hook asks for notes mid-task, sharing the once-only record with the prompt hook', () => {
  withTempDir((dir) => {
    writeHistory(dir, [{ sessionId: 's1', ts: Date.now(), contextUsedPct: 85 }]);
    const input = { session_id: 's1', cwd: '/work/app', hook_event_name: 'PostToolUse', tool_name: 'Edit' };

    const out = hookOutput(runScript(['tool'], { input, stateDir: dir }));
    assert.equal(out.hookEventName, 'PostToolUse');
    assert.match(out.additionalContext, /85% full/);

    assert.equal(runScript(['tool'], { input, stateDir: dir }).stdout, '');
    assert.equal(runScript(['prompt'], { input, stateDir: dir }).stdout, '');
  });
});

test('request context carries the project extra instructions and resume mode', () => {
  withTempDir((dir) => {
    const cwd = makeProject(dir, { extraInstructions: 'Log the session in the brain.', resume: 'schedule' });
    writeHistory(dir, [{ sessionId: 's1', ts: Date.now(), fiveHourPct: 97, fiveHourResetsAt: inOneHour() }]);

    const out = hookOutput(runScript(['prompt'], { input: { session_id: 's1', cwd }, stateDir: dir }));
    assert.match(out.additionalContext, /Log the session in the brain\./);
    assert.match(out.additionalContext, /resume it in the background once the limit resets/);
  });
});

test('stopfail in script mode (the default) leaves a resume script and logs it', () => {
  withTempDir((dir) => {
    const cwd = makeProject(dir);
    const files = resumeFiles(dir, cwd);
    writeHistory(dir, [{ sessionId: 's1', ts: Date.now(), contextTokens: 1234, fiveHourPct: 100, fiveHourResetsAt: inOneHour() }]);

    // Other API errors are not ours to handle.
    runScript(['stopfail'], { input: { session_id: 's1', cwd, error: 'server_error' }, stateDir: dir });
    assert.equal(fs.existsSync(files.plan), false);

    const result = runScript(['stopfail'], { input: { session_id: 's1', cwd, error: 'rate_limit' }, stateDir: dir });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');

    assert.match(fs.readFileSync(files.script, 'utf8'), /claude --resume .s1. /);
    const plan = readJson(files.plan);
    assert.equal(plan.status, 'script');
    assert.equal(plan.contextTokens, 1234);
    assert.deepEqual(readJsonLines(files.log).map((e) => e.event), ['script']);
  });
});

test('stopfail does nothing when the project turned resuming off', () => {
  withTempDir((dir) => {
    const cwd = makeProject(dir, { resume: 'off' });
    runScript(['stopfail'], { input: { session_id: 's1', cwd, error: 'rate_limit' }, stateDir: dir });
    assert.equal(fs.existsSync(path.join(dir, 'resume')), false);
  });
});

test('scheduled resume: stopfail schedules, run-resume launches in the background, next session hears about it', () => {
  withTempDir((dir) => {
    const cwd = makeProject(dir, { resume: 'schedule', permissionMode: 'auto' });
    const files = resumeFiles(dir, cwd);
    const env = testEnv(dir);
    const resetsAt = inOneHour();
    writeHistory(dir, [{ sessionId: 's1', ts: Date.now(), contextTokens: 500, fiveHourPct: 100, fiveHourResetsAt: resetsAt }]);

    runScript(['stopfail'], { input: { session_id: 's1', cwd, error: 'rate_limit' }, stateDir: dir, env });
    const plan = readJson(files.plan);
    assert.equal(plan.status, 'scheduled');
    assert.ok(fs.existsSync(files.script), 'the manual script is kept as a fallback');
    const [scheduled] = readJsonLines(env.CONTEXT_RUNWAY_SCHEDULER_DRYRUN);
    assert.equal(scheduled.action, 'schedule');
    assert.equal(scheduled.runAtMs, plan.runAt);
    assert.ok(plan.runAt > resetsAt * 1000);

    // Pretend the task fires once the limit has reset.
    fs.writeFileSync(files.plan, JSON.stringify({ ...plan, runAt: Date.now() - 1000 }));
    runScript(['run-resume', files.plan], { stateDir: dir, env });

    const launched = readJson(files.plan);
    assert.equal(launched.status, 'launched');
    assert.equal(launched.bgId, 'abc12345');
    assert.deepEqual(readJson(path.join(dir, 'claude-args.json')), ['--bg', '--resume', 's1', '--permission-mode', 'auto', plan.prompt]);
    assert.deepEqual(readJsonLines(env.CONTEXT_RUNWAY_SCHEDULER_DRYRUN).map((e) => e.action), ['schedule', 'unschedule']);
    assert.deepEqual(readJsonLines(files.log).map((e) => e.event), ['scheduled', 'launched']);

    // Running again is a no-op.
    runScript(['run-resume', files.plan], { stateDir: dir, env });
    assert.equal(readJsonLines(files.log).length, 2);

    // The next new session is told once where to follow it.
    const start = hookOutput(runScript(['start'], { input: { session_id: 's9', cwd, source: 'startup' }, stateDir: dir }));
    assert.match(start.additionalContext, /claude attach abc12345/);
    assert.equal(runScript(['start'], { input: { session_id: 's10', cwd, source: 'startup' }, stateDir: dir }).stdout, '');

    const status = runScript(['status'], { stateDir: dir });
    assert.match(status.stdout, /scheduled/);
    assert.match(status.stdout, /claude attach abc12345/);
  });
});

test('run-resume skips a session the user already continued', () => {
  withTempDir((dir) => {
    const cwd = makeProject(dir, { resume: 'schedule' });
    const files = resumeFiles(dir, cwd);
    const env = testEnv(dir);
    writeHistory(dir, [{ sessionId: 's1', ts: Date.now() - 5000, contextTokens: 500, fiveHourPct: 100, fiveHourResetsAt: inOneHour() }]);
    runScript(['stopfail'], { input: { session_id: 's1', cwd, error: 'rate_limit' }, stateDir: dir, env });

    fs.writeFileSync(files.plan, JSON.stringify({ ...readJson(files.plan), runAt: Date.now() - 1000 }));
    // The user resumed it by hand: new tokens well after the settle window.
    fs.appendFileSync(
      path.join(dir, 'usage-history.jsonl'),
      JSON.stringify({ sessionId: 's1', ts: Date.now() + 10 * 60 * 1000, contextTokens: 900 }) + '\n'
    );

    runScript(['run-resume', files.plan], { stateDir: dir, env });
    assert.equal(readJson(files.plan).status, 'skipped');
    assert.equal(fs.existsSync(path.join(dir, 'claude-args.json')), false);
  });
});

test('run-resume leaves the plan scheduled if the task fires before the reset', () => {
  withTempDir((dir) => {
    const cwd = makeProject(dir, { resume: 'schedule' });
    const files = resumeFiles(dir, cwd);
    const env = testEnv(dir);
    writeHistory(dir, [{ sessionId: 's1', ts: Date.now(), fiveHourPct: 100, fiveHourResetsAt: inOneHour() }]);
    runScript(['stopfail'], { input: { session_id: 's1', cwd, error: 'rate_limit' }, stateDir: dir, env });

    runScript(['run-resume', files.plan], { stateDir: dir, env });
    assert.equal(readJson(files.plan).status, 'scheduled');
    assert.equal(fs.existsSync(path.join(dir, 'claude-args.json')), false);

    // The one-off trigger already fired, so it has to be registered again.
    const requests = readJsonLines(path.join(dir, 'scheduler.jsonl'));
    assert.deepEqual(
      requests.map((r) => r.action),
      ['schedule', 'schedule']
    );
    assert.equal(requests[1].runAtMs, readJson(files.plan).runAt);
  });
});

test("run-resume still launches when the cut-off turn's final sample lands late", () => {
  withTempDir((dir) => {
    const cwd = makeProject(dir, { resume: 'schedule' });
    const files = resumeFiles(dir, cwd);
    const env = testEnv(dir);
    writeHistory(dir, [{ sessionId: 's1', ts: Date.now() - 5000, contextTokens: 500, fiveHourPct: 100, fiveHourResetsAt: inOneHour() }]);
    runScript(['stopfail'], { input: { session_id: 's1', cwd, error: 'rate_limit' }, stateDir: dir, env });

    // The throttled status line records the turn's final count just after the hook.
    fs.appendFileSync(
      path.join(dir, 'usage-history.jsonl'),
      JSON.stringify({ sessionId: 's1', ts: Date.now() + 20000, contextTokens: 640 }) + '\n'
    );
    fs.writeFileSync(files.plan, JSON.stringify({ ...readJson(files.plan), runAt: Date.now() - 1000 }));

    runScript(['run-resume', files.plan], { stateDir: dir, env });
    assert.equal(readJson(files.plan).status, 'launched');
  });
});

test('stopfail in schedule mode records a failure when the reset time is unknown', () => {
  withTempDir((dir) => {
    const cwd = makeProject(dir, { resume: 'schedule' });
    const files = resumeFiles(dir, cwd);
    runScript(['stopfail'], { input: { session_id: 's1', cwd, error: 'rate_limit' }, stateDir: dir, env: testEnv(dir) });

    const plan = readJson(files.plan);
    assert.equal(plan.status, 'schedule-failed');
    assert.match(plan.error, /reset time unknown/);
    assert.ok(fs.existsSync(files.script));
  });
});
