import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { attemptPath, getAttempt } from '../src/lib/attempt.mjs';
import { readRunSession, validateRunSession } from '../src/lib/run-session.mjs';
import { listWorkItems, updateWorkItem } from '../src/lib/work.mjs';
import { cleanup, idefactory, repoRoot, tempProject } from './helpers.mjs';

function validSession(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: 'run-abc-123',
    change: 'persist-bounded-run-sessions',
    status: 'open',
    startedAt: '2026-10-21T17:00:00.000Z',
    lastObservedAt: '2026-10-21T17:05:00.000Z',
    budgets: {
      maxAgentSteps: 20,
      maxTasks: 20,
      maxWallClockMs: 14_400_000,
      maxFailures: 5,
    },
    agentSteps: 0,
    completedTasks: 0,
    failureCount: 0,
    baselineDoneIds: [],
    countedFailureIds: [],
    lastRequestFingerprint: null,
    stopReason: null,
    ...overrides,
  };
}

test('schema version 1 session records required fields', () => {
  const fingerprint = {
    action: 'agent-step',
    role: 'engineer',
    taskId: '1.1',
    attemptId: '1dd1b142-2dc7-4317-a6f6-eea9e5019472',
    attemptState: 'implementing',
    workItemStatus: 'in_progress',
  };
  const input = validSession({
    agentSteps: 3,
    completedTasks: 1,
    failureCount: 2,
    lastRequestFingerprint: fingerprint,
    stopReason: 'max-agent-steps',
    status: 'closed',
  });

  const session = validateRunSession(input);

  assert.equal(session.schemaVersion, 1);
  assert.equal(session.runId, 'run-abc-123');
  assert.equal(session.change, 'persist-bounded-run-sessions');
  assert.equal(session.startedAt, '2026-10-21T17:00:00.000Z');
  assert.deepEqual(session.budgets, {
    maxAgentSteps: 20,
    maxTasks: 20,
    maxWallClockMs: 14_400_000,
    maxFailures: 5,
  });
  assert.equal(session.agentSteps, 3);
  assert.equal(session.completedTasks, 1);
  assert.equal(session.failureCount, 2);
  assert.deepEqual(session.lastRequestFingerprint, fingerprint);
  assert.equal(session.stopReason, 'max-agent-steps');
});

test('unsupported schema version is rejected without replacing the file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'run-session-'));
  const file = path.join(dir, 'run.json');
  const original = `${JSON.stringify(validSession({ schemaVersion: 99 }), null, 2)}\n`;
  fs.writeFileSync(file, original);

  assert.throws(
    () => readRunSession(file),
    /unsupported|schema version/i,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('non-JSON session body is rejected without replacing the file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'run-session-'));
  const file = path.join(dir, 'run.json');
  const original = 'not-json{{{';
  fs.writeFileSync(file, original);

  assert.throws(
    () => readRunSession(file),
    /JSON|parse|invalid/i,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

function listRunSessionFiles(project) {
  const runsDir = path.join(project, '.factory', 'orchestration', 'runs');
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(runsDir, name));
}

function demoTaskBlock(id, title) {
  return [
    `- [ ] ${id} ${title}`,
    '  factory:',
    '    kind: general',
    '    checks: [unit]',
    '    verificationProfile: frontend-low',
    '    roles: [engineer, reviewer, scribe]',
    '',
  ].join('\n');
}

async function seedDemoChange(dir, tasksBody) {
  assert.equal((await idefactory(dir, ['init'])).code, 0);
  fs.mkdirSync(path.join(dir, 'openspec/changes/demo'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'openspec/changes/demo/tasks.md'),
    tasksBody || demoTaskBlock('1.1', 'Add parser'),
  );
  assert.equal((await idefactory(dir, ['sync-tasks', 'demo'])).code, 0);
}

function spawnRun(dir, extraArgs = [], envOverrides = {}) {
  return spawnSync(
    process.execPath,
    [path.join(repoRoot, 'src/cli.mjs'), 'run', '--change', 'demo', '--path', dir, ...extraArgs],
    { cwd: dir, encoding: 'utf8', shell: false, env: { ...process.env, ...envOverrides } },
  );
}

function parseOrchestrationJson(out) {
  const match = out.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(match, 'orchestration request must include a json block');
  return JSON.parse(match[1]);
}

/** Advance attempt state so the next run request differs (unchanged-state is task 3.1). */
function advanceAttemptState(dir, attemptId, state) {
  const file = path.join(dir, '.factory', 'attempts', `${attemptId}.json`);
  const attempt = JSON.parse(fs.readFileSync(file, 'utf8'));
  attempt.state = state;
  attempt.history = Array.isArray(attempt.history) ? attempt.history : [];
  attempt.history.push({ at: new Date().toISOString(), state });
  attempt.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, `${JSON.stringify(attempt, null, 2)}\n`);
}

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'idefactory-test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'idefactory-test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function ensureFactoryGitignore(dir) {
  const file = path.join(dir, '.gitignore');
  const lines = [
    '.factory/attempts/*',
    '!.factory/attempts/.gitkeep',
    '.factory/work/',
    '.factory/ledger.jsonl',
    '.factory/orchestration/*',
    '!.factory/orchestration/.gitkeep',
  ];
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const extras = lines.filter((line) => !existing.split('\n').includes(line));
  if (extras.length > 0) {
    fs.writeFileSync(file, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${extras.join('\n')}\n`);
  }
}

function ensureCleanGitCommit(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'idefactory-test']);
  }
  ensureFactoryGitignore(dir);
  git(dir, ['add', '-A']);
  const porcelain = spawnSync('git', ['status', '--porcelain'], {
    cwd: dir,
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(porcelain.status, 0, porcelain.stderr || porcelain.stdout);
  if (porcelain.stdout.trim().length > 0) {
    git(dir, ['commit', '-m', 'checkpoint']);
  }
}

async function recordRed(dir, attemptId) {
  writeCheckRegistry(dir, { unit: 1 });
  const result = await idefactory(dir, [
    'verify', 'run', attemptId, '--check', 'unit', '--red',
  ]);
  assert.equal(result.code, 0, result.err + result.out);
    assert.ok(getAttempt(dir, attemptId).evidence.reds?.unit);
}

async function recordPassingChecks(dir, attemptId) {
  writeCheckRegistry(dir, { unit: 0 });
  ensureCleanGitCommit(dir);
  const result = await idefactory(dir, ['verify', 'run', attemptId, '--check', 'unit']);
  assert.equal(result.code, 0, result.err + result.out);
  assert.equal(
    getAttempt(dir, attemptId).evidence.verification.find((e) => e.kind === 'unit')?.passed,
    true,
  );
}

async function acceptDemoAttempt(dir, attemptId) {
  await recordRed(dir, attemptId);
  const current = getAttempt(dir, attemptId);
  if (current.state === 'assigned') {
    assert.equal((await idefactory(dir, [
      'attempt', 'transition', attemptId, 'implementing',
      '--evidence', JSON.stringify({ implementerId: 'engineer-1' }),
    ])).code, 0);
  }
  assert.equal((await idefactory(dir, [
    'attempt', 'transition', attemptId, 'red-confirmed',
    '--evidence', JSON.stringify({}),
  ])).code, 0);
  await recordPassingChecks(dir, attemptId);
  assert.equal((await idefactory(dir, [
    'attempt', 'transition', attemptId, 'verifying',
    '--evidence', JSON.stringify({}),
  ])).code, 0);
  assert.equal((await idefactory(dir, [
    'attempt', 'transition', attemptId, 'awaiting-review',
    '--evidence', JSON.stringify({}),
  ])).code, 0);
  assert.equal((await idefactory(dir, [
    'attempt', 'transition', attemptId, 'accepted',
    '--evidence', JSON.stringify({ reviewerId: 'reviewer-1', verdict: 'ACCEPT' }),
  ])).code, 0);
}

test('first idefactory run for a change writes .factory/orchestration/runs/<run-id>.json', async () => {
  const dir = tempProject();
  try {
    await seedDemoChange(dir);
    assert.deepEqual(listRunSessionFiles(dir), [], 'no session files before first run');

    const result = await idefactory(dir, ['run', '--change', 'demo', '--max-tasks', '1']);
    assert.equal(result.code, 2, result.err + result.out);

    const files = listRunSessionFiles(dir);
    assert.equal(files.length, 1, `expected one session file, got ${files.join(', ')}`);
    const session = readRunSession(files[0]);
    assert.equal(session.change, 'demo');
    assert.equal(path.basename(files[0]), `${session.runId}.json`);
    assert.ok(files[0].includes(`${path.sep}orchestration${path.sep}runs${path.sep}`));
  } finally {
    cleanup(dir);
  }
});

test('second process resumes the same run id and agent-step count', async () => {
  const dir = tempProject();
  try {
    await seedDemoChange(dir);
    const first = await idefactory(dir, ['run', '--change', 'demo', '--max-tasks', '1']);
    assert.equal(first.code, 2, first.err + first.out);
    advanceAttemptState(dir, parseOrchestrationJson(first.out).attemptId, 'implementing');

    const filesAfterFirst = listRunSessionFiles(dir);
    assert.equal(filesAfterFirst.length, 1);
    const created = readRunSession(filesAfterFirst[0]);
    const bumped = {
      ...created,
      agentSteps: 3,
      lastObservedAt: '2026-10-21T17:10:00.000Z',
    };
    fs.writeFileSync(filesAfterFirst[0], `${JSON.stringify(bumped, null, 2)}\n`);

    const second = spawnRun(dir);
    assert.equal(second.status, 2, second.stderr + second.stdout);

    const filesAfterSecond = listRunSessionFiles(dir);
    assert.equal(filesAfterSecond.length, 1, 'resume must not create a second session file');
    const resumed = readRunSession(filesAfterSecond[0]);
    assert.equal(resumed.runId, created.runId);
    // Second process prints an agent-step request, so the count increments after resume.
    assert.equal(resumed.agentSteps, 4);
    assert.equal(resumed.change, 'demo');
  } finally {
    cleanup(dir);
  }
});

function appendLedger(project, event, data = {}) {
  const file = path.join(project, '.factory', 'ledger.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...data });
  fs.appendFileSync(file, `${line}\n`);
}

test('ledger run-session-opened with missing file and no close exits 1 invalid-session and creates no zeroed session', async () => {
  const dir = tempProject();
  try {
    await seedDemoChange(dir);
    const orphanRunId = 'orphan-run-session-1.3';
    appendLedger(dir, 'run-session-opened', { change: 'demo', runId: orphanRunId });
    assert.deepEqual(listRunSessionFiles(dir), [], 'precondition: no session files');

    const result = await idefactory(dir, ['run', '--change', 'demo', '--max-tasks', '1']);
    assert.equal(result.code, 1, result.err + result.out);
    assert.match(`${result.err}\n${result.out}`, /invalid-session/);
    assert.doesNotMatch(`${result.err}\n${result.out}`, /# Orchestration request/);
    assert.deepEqual(
      listRunSessionFiles(dir),
      [],
      'must not create a zeroed session when ledger open is unmatched',
    );
  } finally {
    cleanup(dir);
  }
});

test('ledger agent-step high-water above loaded file exits 1 without printing a request', async () => {
  const dir = tempProject();
  try {
    await seedDemoChange(dir);
    const first = await idefactory(dir, ['run', '--change', 'demo', '--max-tasks', '1']);
    assert.equal(first.code, 2, first.err + first.out);

    const files = listRunSessionFiles(dir);
    assert.equal(files.length, 1);
    const created = readRunSession(files[0]);
    const lowered = {
      ...created,
      agentSteps: 1,
      lastObservedAt: '2026-10-21T17:12:00.000Z',
    };
    const originalBytes = `${JSON.stringify(lowered, null, 2)}\n`;
    fs.writeFileSync(files[0], originalBytes);
    appendLedger(dir, 'run-session-opened', { change: 'demo', runId: created.runId });
    appendLedger(dir, 'run-agent-step', { change: 'demo', runId: created.runId, agentSteps: 4 });

    const second = spawnRun(dir);
    assert.equal(second.status, 1, second.stderr + second.stdout);
    assert.match(`${second.stderr}\n${second.stdout}`, /invalid-session/);
    assert.doesNotMatch(`${second.stderr}\n${second.stdout}`, /# Orchestration request/);
    assert.equal(fs.readFileSync(files[0], 'utf8'), originalBytes, 'corrupt session bytes stay unchanged');
  } finally {
    cleanup(dir);
  }
});

test('max-agent-steps N allows N cross-process requests then process N+1 stops with max-agent-steps', async () => {
  const dir = tempProject();
  const N = 2;
  const advanceStates = ['implementing'];
  try {
    await seedDemoChange(dir);

    let runId = null;
    for (let step = 1; step <= N; step += 1) {
      const result = spawnRun(dir, ['--max-agent-steps', String(N)]);
      assert.equal(result.status, 2, `process ${step}: ${result.stderr}${result.stdout}`);
      assert.match(result.stdout, /# Orchestration request/);
      assert.match(result.stdout, /"action": "agent-step"/);

      const files = listRunSessionFiles(dir);
      assert.equal(files.length, 1, 'one session file across processes');
      const session = readRunSession(files[0]);
      assert.equal(session.budgets.maxAgentSteps, N);
      assert.equal(
        session.agentSteps,
        step,
        'incremented agentSteps must be persisted before the request is printed',
      );
      assert.equal(session.status, 'open');
      assert.equal(session.stopReason, null);
      if (runId == null) runId = session.runId;
      else assert.equal(session.runId, runId);

      const request = parseOrchestrationJson(result.stdout);
      assert.equal(request.action, 'agent-step');
      if (step < N) {
        advanceAttemptState(dir, request.attemptId, advanceStates[step - 1]);
      }
    }

    const capped = spawnRun(dir, ['--max-agent-steps', String(N)]);
    assert.equal(capped.status, 0, capped.stderr + capped.stdout);
    assert.match(`${capped.stderr}\n${capped.stdout}`, /max-agent-steps/);
    assert.doesNotMatch(`${capped.stderr}\n${capped.stdout}`, /# Orchestration request/);
    assert.doesNotMatch(`${capped.stderr}\n${capped.stdout}`, /"action": "agent-step"/);

    const files = listRunSessionFiles(dir);
    assert.equal(files.length, 1);
    const finalSession = readRunSession(files[0]);
    assert.equal(finalSession.runId, runId);
    assert.equal(finalSession.agentSteps, N);
    assert.equal(finalSession.stopReason, 'max-agent-steps');
    assert.equal(finalSession.status, 'closed');
  } finally {
    cleanup(dir);
  }
});

test('max-tasks counts only tasks finalized during the session; baseline done ids are excluded', async () => {
  const dir = tempProject();
  const maxTasks = 1;
  try {
    await seedDemoChange(
      dir,
      [
        demoTaskBlock('1.1', 'Already done before session'),
        demoTaskBlock('1.2', 'Finalize during session'),
        demoTaskBlock('1.3', 'Still open after cap'),
      ].join('\n'),
    );
    // Work already done at session creation must not count toward max-tasks.
    updateWorkItem(dir, 'demo', '1.1', { status: 'done' });

    const first = spawnRun(dir, ['--max-tasks', String(maxTasks)]);
    assert.equal(first.status, 2, first.stderr + first.stdout);
    assert.match(first.stdout, /# Orchestration request/);
    const firstRequest = parseOrchestrationJson(first.stdout);
    assert.equal(firstRequest.action, 'agent-step');
    assert.equal(firstRequest.taskId, '1.2');

    const filesAfterFirst = listRunSessionFiles(dir);
    assert.equal(filesAfterFirst.length, 1);
    const created = readRunSession(filesAfterFirst[0]);
    assert.equal(created.budgets.maxTasks, maxTasks);
    assert.deepEqual(created.baselineDoneIds, ['1.1']);
    assert.equal(created.completedTasks, 0);
    assert.equal(created.status, 'open');
    assert.equal(created.stopReason, null);

    // Finalize the configured number of tasks during the session.
    updateWorkItem(dir, 'demo', '1.2', { status: 'done' });

    const capped = spawnRun(dir, ['--max-tasks', String(maxTasks)]);
    assert.equal(capped.status, 0, capped.stderr + capped.stdout);
    assert.match(`${capped.stderr}\n${capped.stdout}`, /max-tasks/);
    assert.doesNotMatch(`${capped.stderr}\n${capped.stdout}`, /# Orchestration request/);
    assert.doesNotMatch(`${capped.stderr}\n${capped.stdout}`, /"action": "agent-step"/);

    const filesAfterCap = listRunSessionFiles(dir);
    assert.equal(filesAfterCap.length, 1);
    const finalSession = readRunSession(filesAfterCap[0]);
    assert.equal(finalSession.runId, created.runId);
    assert.deepEqual(finalSession.baselineDoneIds, ['1.1']);
    assert.equal(finalSession.completedTasks, maxTasks);
    assert.equal(finalSession.stopReason, 'max-tasks');
    assert.equal(finalSession.status, 'closed');
  } finally {
    cleanup(dir);
  }
});

test('session past maxWallClockMs exits 0 with wall-clock and no orchestration request', async () => {
  const dir = tempProject();
  const maxWallClockMs = 60_000;
  try {
    await seedDemoChange(dir);
    const first = spawnRun(dir, ['--max-tasks', '1']);
    assert.equal(first.status, 2, first.stderr + first.stdout);

    const files = listRunSessionFiles(dir);
    assert.equal(files.length, 1);
    const created = readRunSession(files[0]);
    const expiredStart = new Date(Date.now() - maxWallClockMs - 5_000).toISOString();
    fs.writeFileSync(
      files[0],
      `${JSON.stringify({
        ...created,
        startedAt: expiredStart,
        budgets: { ...created.budgets, maxWallClockMs },
        lastObservedAt: expiredStart,
      }, null, 2)}\n`,
    );

    const capped = spawnRun(dir, ['--max-tasks', '1']);
    assert.equal(capped.status, 0, capped.stderr + capped.stdout);
    assert.match(`${capped.stderr}\n${capped.stdout}`, /wall-clock/);
    assert.doesNotMatch(`${capped.stderr}\n${capped.stdout}`, /# Orchestration request/);
    assert.doesNotMatch(`${capped.stderr}\n${capped.stdout}`, /"action": "agent-step"/);

    const finalSession = readRunSession(files[0]);
    assert.equal(finalSession.runId, created.runId);
    assert.equal(finalSession.stopReason, 'wall-clock');
    assert.equal(finalSession.status, 'closed');
  } finally {
    cleanup(dir);
  }
});

function writeCheckRegistry(dir, exitByKind) {
  const checks = {};
  for (const [kind, code] of Object.entries(exitByKind)) {
    checks[kind] = {
      argv: [process.execPath, '-e', `process.exit(${code})`],
      cwdPolicy: 'project',
      timeoutMs: 30_000,
      artifacts: [],
    };
  }
  fs.writeFileSync(
    path.join(dir, '.factory/checks.json'),
    `${JSON.stringify({ schemaVersion: 1, checks }, null, 2)}\n`,
  );
}

function appendVerificationRecord(dir, attemptId, record) {
  const file = attemptPath(dir, attemptId);
  const attempt = JSON.parse(fs.readFileSync(file, 'utf8'));
  attempt.evidence.verification = [...(attempt.evidence.verification || []), record];
  fs.writeFileSync(file, `${JSON.stringify(attempt, null, 2)}\n`);
}

test('recorded red result does not increment session failure count', async () => {
  const dir = tempProject();
  try {
    await seedDemoChange(dir);
    const first = spawnRun(dir, ['--max-tasks', '1']);
    assert.equal(first.status, 2, first.stderr + first.stdout);
    const firstRequest = parseOrchestrationJson(first.stdout);
    writeCheckRegistry(dir, { unit: 1 });
    const redRun = await idefactory(dir, [
      'verify', 'run', firstRequest.attemptId, '--check', 'unit', '--red',
    ]);
    assert.equal(redRun.code, 0, redRun.err + redRun.out);
    assert.ok(getAttempt(dir, firstRequest.attemptId).evidence.reds?.unit);

    const filesAfterRed = listRunSessionFiles(dir);
    assert.equal(filesAfterRed.length, 1);
    const afterRed = readRunSession(filesAfterRed[0]);
    assert.equal(afterRed.failureCount, 0);
    assert.deepEqual(afterRed.countedFailureIds, []);
    advanceAttemptState(dir, firstRequest.attemptId, 'implementing');

    const second = spawnRun(dir, ['--max-tasks', '1']);
    assert.equal(second.status, 2, second.stderr + second.stdout);
    const afterRun = readRunSession(filesAfterRed[0]);
    assert.equal(afterRun.failureCount, 0, 'red evidence must not increment failure count');
    assert.deepEqual(afterRun.countedFailureIds, []);
  } finally {
    cleanup(dir);
  }
});

test('--new-run baselines historical failure ids so failureCount stays zero until new failures', async () => {
  const dir = tempProject();
  const maxFailures = 1;
  const historicalFailureId = 'historical-timeout-4-5';
  const newSessionFailureId = 'new-session-timeout-4-5';
  try {
    await seedDemoChange(dir);
    const configPath = path.join(dir, '.factory', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.run = { ...config.run, defaultMaxFailures: maxFailures };
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const first = spawnRun(dir, ['--max-tasks', '1']);
    assert.equal(first.status, 2, first.stderr + first.stdout);
    const firstRequest = parseOrchestrationJson(first.stdout);

    appendVerificationRecord(dir, firstRequest.attemptId, {
      schemaVersion: 1,
      id: historicalFailureId,
      kind: 'unit',
      runner: { name: 'idefactory', version: '0.2.0' },
      argv: [process.execPath, '-e', 'process.exit(1)'],
      commandDigest: 'sha256:historical-failure-4-5',
      exitCode: 1,
      timedOut: true,
      passed: false,
      issuer: 'cli',
      attemptId: firstRequest.attemptId,
      startedAt: '2026-10-21T19:00:00.000Z',
      finishedAt: '2026-10-21T19:01:00.000Z',
      logDigest: 'sha256:historical-log-4-5',
      artifactDigests: [],
      worktreeClean: true,
    });

    const capped = spawnRun(dir, ['--max-tasks', '1']);
    assert.equal(capped.status, 0, capped.stderr + capped.stdout);
    assert.match(`${capped.stderr}\n${capped.stdout}`, /max-failures/);

    const filesAfterCap = listRunSessionFiles(dir);
    assert.equal(filesAfterCap.length, 1);
    const closedSession = readRunSession(filesAfterCap[0]);
    assert.equal(closedSession.stopReason, 'max-failures');
    assert.deepEqual(closedSession.countedFailureIds, [historicalFailureId]);

    const fresh = spawnRun(dir, ['--max-tasks', '1', '--new-run']);
    assert.equal(fresh.status, 2, fresh.stderr + fresh.stdout);
    assert.match(fresh.stdout, /# Orchestration request/);
    assert.doesNotMatch(`${fresh.stderr}\n${fresh.stdout}`, /max-failures/);

    const filesAfterNew = listRunSessionFiles(dir);
    assert.equal(filesAfterNew.length, 2);
    const latest = readRunSession(
      filesAfterNew.sort((a, b) => readRunSession(b).startedAt.localeCompare(readRunSession(a).startedAt))[0],
    );
    assert.notEqual(latest.runId, closedSession.runId);
    assert.equal(latest.failureCount, 0);
    assert.deepEqual(latest.baselineFailureIds, [historicalFailureId]);
    assert.deepEqual(latest.countedFailureIds, []);

    appendVerificationRecord(dir, firstRequest.attemptId, {
      schemaVersion: 1,
      id: newSessionFailureId,
      kind: 'unit',
      runner: { name: 'idefactory', version: '0.2.0' },
      argv: [process.execPath, '-e', 'process.exit(1)'],
      commandDigest: 'sha256:new-session-failure-4-5',
      exitCode: 1,
      timedOut: true,
      passed: false,
      issuer: 'cli',
      attemptId: firstRequest.attemptId,
      startedAt: '2026-10-21T19:10:00.000Z',
      finishedAt: '2026-10-21T19:11:00.000Z',
      logDigest: 'sha256:new-session-log-4-5',
      artifactDigests: [],
      worktreeClean: true,
    });

    const cappedAgain = spawnRun(dir, ['--max-tasks', '1']);
    assert.equal(cappedAgain.status, 0, cappedAgain.stderr + cappedAgain.stdout);
    assert.match(`${cappedAgain.stderr}\n${cappedAgain.stdout}`, /max-failures/);
    assert.doesNotMatch(`${cappedAgain.stderr}\n${cappedAgain.stdout}`, /# Orchestration request/);

    const finalSession = readRunSession(
      filesAfterNew.sort((a, b) => readRunSession(b).startedAt.localeCompare(readRunSession(a).startedAt))[0],
    );
    assert.equal(finalSession.failureCount, maxFailures);
    assert.deepEqual(finalSession.countedFailureIds, [newSessionFailureId]);
    assert.equal(finalSession.stopReason, 'max-failures');
    assert.equal(finalSession.status, 'closed');
  } finally {
    cleanup(dir);
  }
});

test('timed-out verification failures at maxFailures exit 0 with max-failures and no request', async () => {
  const dir = tempProject();
  const maxFailures = 1;
  const failureId = 'timeout-record-2-4';
  try {
    await seedDemoChange(dir);
    const first = spawnRun(dir, ['--max-tasks', '1']);
    assert.equal(first.status, 2, first.stderr + first.stdout);
    const firstRequest = parseOrchestrationJson(first.stdout);

    appendVerificationRecord(dir, firstRequest.attemptId, {
      schemaVersion: 1,
      id: failureId,
      kind: 'unit',
      runner: { name: 'idefactory', version: '0.2.0' },
      argv: [process.execPath, '-e', 'setTimeout(() => {}, 99999)'],
      commandDigest: 'sha256:timeout-failure-2-4',
      exitCode: 1,
      timedOut: true,
      passed: false,
      issuer: 'cli',
      attemptId: firstRequest.attemptId,
      startedAt: '2026-10-21T18:10:00.000Z',
      finishedAt: '2026-10-21T18:11:00.000Z',
      logDigest: 'sha256:timeout-log-2-4',
      artifactDigests: [],
      worktreeClean: true,
    });

    const files = listRunSessionFiles(dir);
    assert.equal(files.length, 1);
    const created = readRunSession(files[0]);
    fs.writeFileSync(
      files[0],
      `${JSON.stringify({
        ...created,
        budgets: { ...created.budgets, maxFailures },
        failureCount: 0,
        countedFailureIds: [],
      }, null, 2)}\n`,
    );

    const capped = spawnRun(dir, ['--max-tasks', '1']);
    assert.equal(capped.status, 0, capped.stderr + capped.stdout);
    assert.match(`${capped.stderr}\n${capped.stdout}`, /max-failures/);
    assert.doesNotMatch(`${capped.stderr}\n${capped.stdout}`, /# Orchestration request/);
    assert.doesNotMatch(`${capped.stderr}\n${capped.stdout}`, /"action": "agent-step"/);

    const finalSession = readRunSession(files[0]);
    assert.equal(finalSession.failureCount, maxFailures);
    assert.deepEqual(finalSession.countedFailureIds, [failureId]);
    assert.equal(finalSession.stopReason, 'max-failures');
    assert.equal(finalSession.status, 'closed');
  } finally {
    cleanup(dir);
  }
});

test('clock earlier than startedAt exits 1 with invalid-session and no orchestration request', async () => {
  const dir = tempProject();
  try {
    await seedDemoChange(dir);
    const first = spawnRun(dir, ['--max-tasks', '1']);
    assert.equal(first.status, 2, first.stderr + first.stdout);

    const files = listRunSessionFiles(dir);
    assert.equal(files.length, 1);
    const created = readRunSession(files[0]);
    const futureStart = new Date(Date.now() + 3_600_000).toISOString();
    fs.writeFileSync(
      files[0],
      `${JSON.stringify({
        ...created,
        startedAt: futureStart,
        lastObservedAt: futureStart,
      }, null, 2)}\n`,
    );

    const regressed = spawnRun(dir, ['--max-tasks', '1']);
    assert.equal(regressed.status, 1, regressed.stderr + regressed.stdout);
    assert.match(`${regressed.stderr}\n${regressed.stdout}`, /invalid-session/);
    assert.doesNotMatch(`${regressed.stderr}\n${regressed.stdout}`, /# Orchestration request/);

    const finalSession = readRunSession(files[0]);
    assert.equal(finalSession.runId, created.runId);
    assert.equal(finalSession.stopReason, 'invalid-session');
    assert.equal(finalSession.status, 'closed');
  } finally {
    cleanup(dir);
  }
});

function assertInvalidBudgetRun(dir, extraArgs, label) {
  assert.deepEqual(listRunSessionFiles(dir), [], `precondition: no session before ${label}`);
  const result = spawnRun(dir, extraArgs);
  assert.equal(result.status, 1, `${label}: ${result.stderr}${result.stdout}`);
  assert.match(`${result.stderr}\n${result.stdout}`, /invalid-budget/);
  assert.doesNotMatch(`${result.stderr}\n${result.stdout}`, /# Orchestration request/);
  assert.deepEqual(
    listRunSessionFiles(dir),
    [],
    `${label}: must not create a zeroed open session file`,
  );
}

test('zero, negative, or non-integer required budgets exit 1 with invalid-budget and no session', async () => {
  const dir = tempProject();
  try {
    await seedDemoChange(dir);
    const cases = [
      [['--max-agent-steps', '0'], 'zero max-agent-steps'],
      [['--max-agent-steps', '-1'], 'negative max-agent-steps'],
      [['--max-agent-steps', '2.5'], 'non-integer max-agent-steps'],
      [['--max-tasks', '0'], 'zero max-tasks'],
      [['--max-tasks', '-3'], 'negative max-tasks'],
      [['--max-tasks', 'nope'], 'non-integer max-tasks'],
    ];
    for (const [args, label] of cases) {
      assertInvalidBudgetRun(dir, args, label);
    }
  } finally {
    cleanup(dir);
  }
});

test('bare --max-agent-steps flag does not fall through via truthiness to a session', async () => {
  const dir = tempProject();
  try {
    await seedDemoChange(dir);
    assertInvalidBudgetRun(dir, ['--max-agent-steps'], 'bare max-agent-steps flag');
  } finally {
    cleanup(dir);
  }
});

test('invalid config budget exits 1 with invalid-budget and creates no session file', async () => {
  const dir = tempProject();
  try {
    await seedDemoChange(dir);
    const configPath = path.join(dir, '.factory', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.run = { ...config.run, defaultMaxFailures: 0 };
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    assertInvalidBudgetRun(dir, ['--max-tasks', '1'], 'zero defaultMaxFailures in config');
  } finally {
    cleanup(dir);
  }
});

test('corrupt session JSON on resume exits 1 with unchanged bytes and no request', async () => {
  const dir = tempProject();
  try {
    await seedDemoChange(dir);
    const first = spawnRun(dir, ['--max-tasks', '1']);
    assert.equal(first.status, 2, first.stderr + first.stdout);

    const files = listRunSessionFiles(dir);
    assert.equal(files.length, 1);
    const original = 'not-json{{{';
    fs.writeFileSync(files[0], original);

    const second = spawnRun(dir, ['--max-tasks', '1']);
    assert.equal(second.status, 1, second.stderr + second.stdout);
    assert.doesNotMatch(`${second.stderr}\n${second.stdout}`, /# Orchestration request/);
    assert.equal(fs.readFileSync(files[0], 'utf8'), original, 'corrupt session bytes stay unchanged');
  } finally {
    cleanup(dir);
  }
});

test('session missing required counter on resume exits 1 with unchanged bytes and no request', async () => {
  const dir = tempProject();
  try {
    await seedDemoChange(dir);
    const first = spawnRun(dir, ['--max-tasks', '1']);
    assert.equal(first.status, 2, first.stderr + first.stdout);

    const files = listRunSessionFiles(dir);
    assert.equal(files.length, 1);
    const parsed = JSON.parse(fs.readFileSync(files[0], 'utf8'));
    delete parsed.agentSteps;
    const original = `${JSON.stringify(parsed, null, 2)}\n`;
    fs.writeFileSync(files[0], original);

    const second = spawnRun(dir, ['--max-tasks', '1']);
    assert.equal(second.status, 1, second.stderr + second.stdout);
    assert.doesNotMatch(`${second.stderr}\n${second.stdout}`, /# Orchestration request/);
    assert.equal(fs.readFileSync(files[0], 'utf8'), original);
  } finally {
    cleanup(dir);
  }
});

function expectedFingerprint(request, attemptState, workItemStatus) {
  return {
    action: request.action,
    role: request.role,
    taskId: request.taskId,
    attemptId: request.attemptId,
    attemptState,
    workItemStatus,
  };
}

test('second process with same attempt role and work-item status exits 0 unchanged-state with no request', async () => {
  const dir = tempProject();
  try {
    await seedDemoChange(dir);
    const first = spawnRun(dir, ['--max-agent-steps', '5']);
    assert.equal(first.status, 2, first.stderr + first.stdout);
    const firstRequest = parseOrchestrationJson(first.stdout);
    assert.equal(firstRequest.action, 'agent-step');

    const filesAfterFirst = listRunSessionFiles(dir);
    assert.equal(filesAfterFirst.length, 1);
    const afterFirst = readRunSession(filesAfterFirst[0]);
    assert.deepEqual(
      afterFirst.lastRequestFingerprint,
      expectedFingerprint(firstRequest, firstRequest.state, 'in_progress'),
    );
    assert.equal(afterFirst.agentSteps, 1);

    const second = spawnRun(dir, ['--max-agent-steps', '5']);
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.match(`${second.stderr}\n${second.stdout}`, /unchanged-state/);
    assert.doesNotMatch(`${second.stderr}\n${second.stdout}`, /# Orchestration request/);

    const afterSecond = readRunSession(filesAfterFirst[0]);
    assert.equal(afterSecond.agentSteps, 1, 'unchanged-state must not increment agent steps');
    assert.equal(afterSecond.stopReason, 'unchanged-state');
    assert.equal(afterSecond.status, 'closed');
    assert.deepEqual(afterSecond.lastRequestFingerprint, afterFirst.lastRequestFingerprint);
  } finally {
    cleanup(dir);
  }
});

test('after implementing CLI red and red-confirmed transition repeat run exits 0 unchanged-state', async () => {
  const dir = tempProject();
  try {
    await seedDemoChange(dir);

    const first = spawnRun(dir, ['--max-agent-steps', '10']);
    assert.equal(first.status, 2, first.stderr + first.stdout);
    const firstRequest = parseOrchestrationJson(first.stdout);
    assert.equal(
      (await idefactory(dir, [
        'attempt', 'transition', firstRequest.attemptId, 'implementing',
      ])).code,
      0,
    );

    const second = spawnRun(dir, ['--max-agent-steps', '10']);
    assert.equal(second.status, 2, second.stderr + second.stdout);
    const secondRequest = parseOrchestrationJson(second.stdout);
    assert.equal(secondRequest.state, 'implementing');

    writeCheckRegistry(dir, { unit: 1 });
    const redRun = await idefactory(dir, [
      'verify', 'run', firstRequest.attemptId, '--check', 'unit', '--red',
    ]);
    assert.equal(redRun.code, 0, redRun.err + redRun.out);
    assert.ok(getAttempt(dir, firstRequest.attemptId).evidence.reds?.unit);

    assert.equal(
      (await idefactory(dir, [
        'attempt', 'transition', firstRequest.attemptId, 'red-confirmed',
      ])).code,
      0,
    );

    const third = spawnRun(dir, ['--max-agent-steps', '10']);
    assert.equal(third.status, 2, third.stderr + third.stdout);
    const thirdRequest = parseOrchestrationJson(third.stdout);
    assert.equal(thirdRequest.state, 'red-confirmed');

    const files = listRunSessionFiles(dir);
    const afterThird = readRunSession(files[0]);
    assert.equal(afterThird.agentSteps, 3);
    assert.deepEqual(
      afterThird.lastRequestFingerprint,
      expectedFingerprint(thirdRequest, 'red-confirmed', 'in_progress'),
    );

    const fourth = spawnRun(dir, ['--max-agent-steps', '10']);
    assert.equal(fourth.status, 0, fourth.stderr + fourth.stdout);
    assert.match(`${fourth.stderr}\n${fourth.stdout}`, /unchanged-state/);
    assert.doesNotMatch(`${fourth.stderr}\n${fourth.stdout}`, /# Orchestration request/);

    const afterFourth = readRunSession(files[0]);
    assert.equal(afterFourth.agentSteps, 3);
    assert.equal(afterFourth.stopReason, 'unchanged-state');
    assert.equal(afterFourth.status, 'closed');
  } finally {
    cleanup(dir);
  }
});

test('sticky max-agent-steps session does not reset on a later process without --new-run', async () => {
  const dir = tempProject();
  const N = 1;
  try {
    await seedDemoChange(dir);
    const capped = spawnRun(dir, ['--max-agent-steps', String(N)]);
    assert.equal(capped.status, 2, capped.stderr + capped.stdout);
    advanceAttemptState(dir, parseOrchestrationJson(capped.stdout).attemptId, 'implementing');

    const stopped = spawnRun(dir, ['--max-agent-steps', String(N)]);
    assert.equal(stopped.status, 0, stopped.stderr + stopped.stdout);
    assert.match(`${stopped.stderr}\n${stopped.stdout}`, /max-agent-steps/);

    const filesAfterStop = listRunSessionFiles(dir);
    assert.equal(filesAfterStop.length, 1);
    const closedBytes = fs.readFileSync(filesAfterStop[0], 'utf8');
    const closedSession = readRunSession(filesAfterStop[0]);
    assert.equal(closedSession.stopReason, 'max-agent-steps');
    assert.equal(closedSession.agentSteps, N);

    const again = spawnRun(dir, ['--max-agent-steps', String(N)]);
    assert.equal(again.status, 0, again.stderr + again.stdout);
    assert.match(`${again.stderr}\n${again.stdout}`, /max-agent-steps/);
    assert.doesNotMatch(`${again.stderr}\n${again.stdout}`, /# Orchestration request/);
    assert.equal(listRunSessionFiles(dir).length, 1);
    assert.equal(fs.readFileSync(filesAfterStop[0], 'utf8'), closedBytes);
    assert.equal(readRunSession(filesAfterStop[0]).agentSteps, N);
  } finally {
    cleanup(dir);
  }
});

test('--new-run after max-agent-steps opens a new run id at zero steps and keeps the previous file', async () => {
  const dir = tempProject();
  const N = 1;
  try {
    await seedDemoChange(dir);
    const first = spawnRun(dir, ['--max-agent-steps', String(N)]);
    assert.equal(first.status, 2, first.stderr + first.stdout);
    advanceAttemptState(dir, parseOrchestrationJson(first.stdout).attemptId, 'implementing');

    const stopped = spawnRun(dir, ['--max-agent-steps', String(N)]);
    assert.equal(stopped.status, 0, stopped.stderr + stopped.stdout);

    const filesAfterStop = listRunSessionFiles(dir);
    assert.equal(filesAfterStop.length, 1);
    const previousPath = filesAfterStop[0];
    const previousSession = readRunSession(previousPath);
    const previousBytes = fs.readFileSync(previousPath, 'utf8');
    assert.equal(previousSession.stopReason, 'max-agent-steps');
    assert.equal(previousSession.agentSteps, N);

    const fresh = spawnRun(dir, ['--max-agent-steps', String(N), '--new-run']);
    assert.equal(fresh.status, 2, fresh.stderr + fresh.stdout);
    assert.match(fresh.stdout, /# Orchestration request/);

    const filesAfterNew = listRunSessionFiles(dir);
    assert.equal(filesAfterNew.length, 2);
    assert.equal(fs.readFileSync(previousPath, 'utf8'), previousBytes);

    const latest = readRunSession(
      filesAfterNew.sort((a, b) => readRunSession(b).startedAt.localeCompare(readRunSession(a).startedAt))[0],
    );
    assert.notEqual(latest.runId, previousSession.runId);
    assert.equal(latest.agentSteps, 1);
    assert.equal(latest.status, 'open');
    assert.equal(latest.stopReason, null);
    assert.equal(latest.budgets.maxAgentSteps, N);
  } finally {
    cleanup(dir);
  }
});

test('host tokens at configured ceiling exit 0 with max-tokens and no orchestration request', async () => {
  const dir = tempProject();
  const ceiling = 1000;
  const exposed = ceiling;
  try {
    await seedDemoChange(dir);
    const capped = spawnRun(dir, [
      '--max-tasks', '1',
      '--max-agent-steps', '5',
      '--max-tokens', String(ceiling),
      '--host-tokens', String(exposed),
    ]);
    assert.equal(capped.status, 0, capped.stderr + capped.stdout);
    assert.match(`${capped.stderr}\n${capped.stdout}`, /max-tokens/);
    assert.doesNotMatch(`${capped.stderr}\n${capped.stdout}`, /# Orchestration request/);

    const files = listRunSessionFiles(dir);
    assert.equal(files.length, 1);
    const session = readRunSession(files[0]);
    assert.equal(session.budgets.maxTokens, ceiling);
    assert.equal(session.hostTokens, exposed);
    assert.equal(session.stopReason, 'max-tokens');
    assert.equal(session.status, 'closed');
    assert.equal(session.hostCost, undefined);
  } finally {
    cleanup(dir);
  }
});

test('configured cost ceiling without exposed host cost exits 1 host-usage-unavailable and no request', async () => {
  const dir = tempProject();
  try {
    await seedDemoChange(dir);
    const result = spawnRun(dir, ['--max-tasks', '1', '--max-cost', '50']);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(`${result.stderr}\n${result.stdout}`, /host-usage-unavailable/);
    assert.doesNotMatch(`${result.stderr}\n${result.stdout}`, /# Orchestration request/);

    const files = listRunSessionFiles(dir);
    assert.equal(files.length, 1);
    const session = readRunSession(files[0]);
    assert.equal(session.budgets.maxCost, 50);
    assert.equal(session.stopReason, 'host-usage-unavailable');
    assert.equal(session.status, 'closed');
    assert.equal(session.hostCost, undefined);
    assert.equal(session.hostTokens, undefined);
  } finally {
    cleanup(dir);
  }
});

test('without token or cost ceiling the session stores neither metric even when env exposes values', async () => {
  const dir = tempProject();
  try {
    await seedDemoChange(dir);
    const result = spawnRun(
      dir,
      ['--max-tasks', '1', '--max-agent-steps', '5'],
      { IDEFACTORY_HOST_TOKENS: '99999', IDEFACTORY_HOST_COST: '12.5' },
    );
    assert.equal(result.status, 2, result.stderr + result.stdout);
    assert.match(result.stdout, /# Orchestration request/);

    const session = readRunSession(listRunSessionFiles(dir)[0]);
    assert.equal(session.budgets.maxTokens, undefined);
    assert.equal(session.budgets.maxCost, undefined);
    assert.equal(session.hostTokens, undefined);
    assert.equal(session.hostCost, undefined);
  } finally {
    cleanup(dir);
  }
});

test('max-tokens ceiling from config and host tokens from env enforce at ceiling', async () => {
  const dir = tempProject();
  const ceiling = 500;
  try {
    await seedDemoChange(dir);
    const configPath = path.join(dir, '.factory', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.run = { ...config.run, maxTokens: ceiling };
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const capped = spawnRun(dir, ['--max-tasks', '1'], { IDEFACTORY_HOST_TOKENS: String(ceiling) });
    assert.equal(capped.status, 0, capped.stderr + capped.stdout);
    assert.match(`${capped.stderr}\n${capped.stdout}`, /max-tokens/);
    const session = readRunSession(listRunSessionFiles(dir)[0]);
    assert.equal(session.budgets.maxTokens, ceiling);
    assert.equal(session.hostTokens, ceiling);
  } finally {
    cleanup(dir);
  }
});

test('nonpositive token ceiling or negative host tokens fail closed with invalid-budget', async () => {
  const dir = tempProject();
  try {
    await seedDemoChange(dir);
    for (const [args, label] of [
      [['--max-tokens', '0', '--host-tokens', '1'], 'zero max-tokens ceiling'],
      [['--max-tokens', '-5', '--host-tokens', '1'], 'negative max-tokens ceiling'],
      [['--max-tokens', '10', '--host-tokens', '-1'], 'negative host-tokens'],
    ]) {
      assertInvalidBudgetRun(dir, args, label);
    }
  } finally {
    cleanup(dir);
  }
});

test('accepted attempt emits complete request without incrementing agent steps', async () => {
  const dir = tempProject();
  try {
    await seedDemoChange(dir);

    const first = spawnRun(dir, ['--max-agent-steps', '10']);
    assert.equal(first.status, 2, first.stderr + first.stdout);
    const firstRequest = parseOrchestrationJson(first.stdout);
    assert.equal(firstRequest.action, 'agent-step');

    assert.equal((await idefactory(dir, [
      'attempt', 'transition', firstRequest.attemptId, 'implementing',
      '--evidence', JSON.stringify({ implementerId: 'engineer-1' }),
    ])).code, 0);

    const second = spawnRun(dir, ['--max-agent-steps', '10']);
    assert.equal(second.status, 2, second.stderr + second.stdout);
    assert.equal(parseOrchestrationJson(second.stdout).action, 'agent-step');

    const files = listRunSessionFiles(dir);
    assert.equal(files.length, 1);
    const beforeComplete = readRunSession(files[0]);
    assert.equal(beforeComplete.agentSteps, 2);

    await acceptDemoAttempt(dir, firstRequest.attemptId);

    const completeRun = spawnRun(dir, ['--max-agent-steps', '10']);
    assert.equal(completeRun.status, 2, completeRun.stderr + completeRun.stdout);
    assert.match(completeRun.stdout, /# Orchestration request/);
    const completeRequest = parseOrchestrationJson(completeRun.stdout);
    assert.equal(completeRequest.action, 'complete');
    assert.equal(completeRequest.role, 'scribe');

    const afterComplete = readRunSession(files[0]);
    assert.equal(afterComplete.agentSteps, 2, 'complete request must not increment agent steps');
    assert.deepEqual(afterComplete.lastRequestFingerprint, {
      action: 'complete',
      role: 'scribe',
      taskId: firstRequest.taskId,
      attemptId: firstRequest.attemptId,
      attemptState: 'accepted',
      workItemStatus: 'in_progress',
    });
  } finally {
    cleanup(dir);
  }
});

test('repeat complete request with unchanged attempt exits 0 unchanged-state without incrementing steps', async () => {
  const dir = tempProject();
  try {
    await seedDemoChange(dir);

    const first = spawnRun(dir, ['--max-agent-steps', '10']);
    assert.equal(first.status, 2, first.stderr + first.stdout);
    const attemptId = parseOrchestrationJson(first.stdout).attemptId;
    await acceptDemoAttempt(dir, attemptId);

    const completeRun = spawnRun(dir, ['--max-agent-steps', '10']);
    assert.equal(completeRun.status, 2, completeRun.stderr + completeRun.stdout);
    assert.equal(parseOrchestrationJson(completeRun.stdout).action, 'complete');

    const files = listRunSessionFiles(dir);
    const afterFirstComplete = readRunSession(files[0]);
    assert.equal(afterFirstComplete.agentSteps, 1);

    const repeat = spawnRun(dir, ['--max-agent-steps', '10']);
    assert.equal(repeat.status, 0, repeat.stderr + repeat.stdout);
    assert.match(`${repeat.stderr}\n${repeat.stdout}`, /unchanged-state/);
    assert.doesNotMatch(`${repeat.stderr}\n${repeat.stdout}`, /# Orchestration request/);

    const afterRepeat = readRunSession(files[0]);
    assert.equal(afterRepeat.agentSteps, 1);
    assert.equal(afterRepeat.stopReason, 'unchanged-state');
    assert.equal(afterRepeat.status, 'closed');
    assert.deepEqual(afterRepeat.lastRequestFingerprint, afterFirstComplete.lastRequestFingerprint);
  } finally {
    cleanup(dir);
  }
});

test('HALT before first run creates no session and prints no request', async () => {
  const dir = tempProject();
  try {
    await seedDemoChange(dir);
    fs.writeFileSync(path.join(dir, 'HALT'), 'stop\n');
    assert.deepEqual(listRunSessionFiles(dir), []);

    const result = spawnRun(dir, ['--max-tasks', '1']);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(`${result.stderr}\n${result.stdout}`, /HALT/);
    assert.doesNotMatch(`${result.stderr}\n${result.stdout}`, /# Orchestration request/);
    assert.deepEqual(listRunSessionFiles(dir), []);
  } finally {
    cleanup(dir);
  }
});

test('HALT with an existing session leaves session bytes unchanged and prints no request', async () => {
  const dir = tempProject();
  try {
    await seedDemoChange(dir);
    const first = spawnRun(dir, ['--max-tasks', '1']);
    assert.equal(first.status, 2, first.stderr + first.stdout);

    const files = listRunSessionFiles(dir);
    assert.equal(files.length, 1);
    const originalBytes = fs.readFileSync(files[0], 'utf8');

    fs.writeFileSync(path.join(dir, 'HALT'), 'stop\n');
    const halted = spawnRun(dir, ['--max-tasks', '1']);
    assert.equal(halted.status, 1, halted.stderr + halted.stdout);
    assert.match(`${halted.stderr}\n${halted.stdout}`, /HALT/);
    assert.doesNotMatch(`${halted.stderr}\n${halted.stdout}`, /# Orchestration request/);
    assert.equal(fs.readFileSync(files[0], 'utf8'), originalBytes);
    assert.equal(listRunSessionFiles(dir).length, 1);
  } finally {
    cleanup(dir);
  }
});

const FACTORY_RUN_SKILL_COPIES = [
  '.cursor/skills/factory-run/SKILL.md',
  '.github/skills/factory-run/SKILL.md',
  '.agents/skills/factory-run/SKILL.md',
  '.claude/skills/factory-run/SKILL.md',
  'templates/skills/factory-run/SKILL.md',
];

const BOUNDED_RUN_SKILL_STOPS = [
  'max-agent-steps',
  'max-tasks',
  'wall-clock',
  'max-failures',
  'unchanged-state',
  'vacuous-red',
  'infrastructure-failure',
  'baseline',
  'retry-cap',
];

function factoryRunSkillLoopSection(text) {
  const start = text.indexOf('## Loop');
  assert.notEqual(start, -1, 'factory-run skill must have a Loop section');
  const afterLoop = text.indexOf('\n## ', start + 1);
  return afterLoop === -1 ? text.slice(start) : text.slice(start, afterLoop);
}

test('shipped factory-run skill copies name bounded stop reasons and resume without --new-run', () => {
  for (const rel of FACTORY_RUN_SKILL_COPIES) {
    const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    for (const stop of BOUNDED_RUN_SKILL_STOPS) {
      assert.match(text, new RegExp(stop), `${rel} must name stop ${stop}`);
    }
    const loop = factoryRunSkillLoopSection(text);
    assert.doesNotMatch(loop, /--new-run/, `${rel} loop must not pass --new-run`);
    if (text.includes('--new-run')) {
      assert.match(
        text,
        /human[\s\S]*--new-run|--new-run[\s\S]*human|New session \(human only\)/i,
        `${rel} must describe --new-run only as an explicit human action`,
      );
    }
  }
});

test('resume flag higher than stored max-agent-steps budget does not raise the stored cap', async () => {
  const dir = tempProject();
  const storedCap = 2;
  const higherFlag = 5;
  try {
    await seedDemoChange(dir);

    const first = spawnRun(dir, ['--max-agent-steps', String(storedCap)]);
    assert.equal(first.status, 2, first.stderr + first.stdout);
    advanceAttemptState(dir, parseOrchestrationJson(first.stdout).attemptId, 'implementing');

    const second = spawnRun(dir, ['--max-agent-steps', String(storedCap)]);
    assert.equal(second.status, 2, second.stderr + second.stdout);
    advanceAttemptState(dir, parseOrchestrationJson(second.stdout).attemptId, 'red-confirmed');

    const files = listRunSessionFiles(dir);
    const sessionMid = readRunSession(files[0]);
    assert.equal(sessionMid.budgets.maxAgentSteps, storedCap);
    assert.equal(sessionMid.agentSteps, 2);

    const third = spawnRun(dir, ['--max-agent-steps', String(higherFlag)]);
    assert.equal(third.status, 0, third.stderr + third.stdout);
    assert.match(`${third.stderr}\n${third.stdout}`, /max-agent-steps/);
    assert.doesNotMatch(`${third.stderr}\n${third.stdout}`, /# Orchestration request/);

    const finalSession = readRunSession(files[0]);
    assert.equal(finalSession.budgets.maxAgentSteps, storedCap);
    assert.equal(finalSession.agentSteps, storedCap);
    assert.equal(finalSession.stopReason, 'max-agent-steps');
  } finally {
    cleanup(dir);
  }
});

test('implementation notes record strict validate, npm test, and doctor', () => {
  const notesPath = path.join(
    repoRoot,
    'openspec/changes/archive/2026-10-22-persist-bounded-run-sessions/implementation-notes.md',
  );
  assert.ok(
    fs.existsSync(notesPath),
    `missing implementation notes: ${notesPath}`,
  );
  const notes = fs.readFileSync(notesPath, 'utf8');
  assert.match(notes, /npx openspec validate persist-bounded-run-sessions --strict/);
  assert.match(notes, /npm test/);
  assert.match(notes, /node src\/cli\.mjs doctor/);
});

function writeBaselineCheck(dir, argv) {
  fs.writeFileSync(path.join(dir, '.factory/checks.json'), `${JSON.stringify({
    schemaVersion: 1,
    checks: {
      unit: {
        argv,
        cwdPolicy: 'project',
        timeoutMs: 5000,
        artifacts: [],
      },
    },
  }, null, 2)}\n`);
}

test('baseline stops for infrastructure or assertion failure and continues when accepted or green', async () => {
  const infra = tempProject();
  try {
    await seedDemoChange(infra);
    writeBaselineCheck(infra, ['definitely-missing-idefactory-bin']);
    const stopped = spawnRun(infra, ['--max-tasks', '1']);
    assert.equal(stopped.status, 0, stopped.stderr + stopped.stdout);
    assert.match(stopped.stdout, /infrastructure-failure/);
    assert.match(stopped.stdout, /idefactory setup/);
    assert.doesNotMatch(stopped.stdout, /# Orchestration request/);
  } finally {
    cleanup(infra);
  }

  const red = tempProject();
  try {
    await seedDemoChange(red);
    writeCheckRegistry(red, { unit: 1 });
    const stopped = spawnRun(red, ['--max-tasks', '1']);
    assert.equal(stopped.status, 0, stopped.stderr + stopped.stdout);
    assert.match(stopped.stdout, /baseline/);
    assert.doesNotMatch(stopped.stdout, /# Orchestration request/);
    const attemptId = listWorkItems(red, 'demo')[0].attemptId;
    assert.equal(getAttempt(red, attemptId).evidence.reds, undefined);

    const accepted = spawnRun(red, ['--max-tasks', '1', '--accept-baseline']);
    assert.equal(accepted.status, 2, accepted.stderr + accepted.stdout);
    assert.match(accepted.stdout, /# Orchestration request/);
    assert.equal(getAttempt(red, attemptId).evidence.reds, undefined);
    const session = readRunSession(listRunSessionFiles(red)[0]);
    assert.equal(session.testBaseline.result, 'accepted');
  } finally {
    cleanup(red);
  }

  const green = tempProject();
  try {
    await seedDemoChange(green);
    writeCheckRegistry(green, { unit: 0 });
    const continued = spawnRun(green, ['--max-tasks', '1']);
    assert.equal(continued.status, 2, continued.stderr + continued.stdout);
    assert.match(continued.stdout, /# Orchestration request/);
    const session = readRunSession(listRunSessionFiles(green)[0]);
    assert.equal(session.testBaseline.result, 'passed');
  } finally {
    cleanup(green);
  }
});

test('the fourth identical infrastructure failure sticks at retry-cap and an earlier one can be retried', async () => {
  const dir = tempProject();
  try {
    await seedDemoChange(dir);
    writeBaselineCheck(dir, ['definitely-missing-idefactory-bin']);
    for (let n = 1; n <= 3; n += 1) {
      const stopped = spawnRun(dir, ['--max-tasks', '1']);
      assert.equal(stopped.status, 0, stopped.stderr + stopped.stdout);
      assert.match(stopped.stdout, /infrastructure-failure/);
      assert.doesNotMatch(stopped.stdout, /# Orchestration request/);
    }
    const capped = spawnRun(dir, ['--max-tasks', '1']);
    assert.equal(capped.status, 0, capped.stderr + capped.stdout);
    assert.match(capped.stdout, /retry-cap/);
    assert.doesNotMatch(capped.stdout, /# Orchestration request/);
    const again = spawnRun(dir, ['--max-tasks', '1']);
    assert.equal(again.status, 0, again.stderr + again.stdout);
    assert.match(again.stdout, /retry-cap/);
    assert.doesNotMatch(again.stdout, /# Orchestration request/);
  } finally {
    cleanup(dir);
  }

  const retry = tempProject();
  try {
    await seedDemoChange(retry);
    writeBaselineCheck(retry, ['definitely-missing-idefactory-bin']);
    const stopped = spawnRun(retry, ['--max-tasks', '1']);
    assert.match(stopped.stdout, /infrastructure-failure/);
    writeCheckRegistry(retry, { unit: 0 });
    const continued = spawnRun(retry, ['--max-tasks', '1']);
    assert.equal(continued.status, 2, continued.stderr + continued.stdout);
    assert.match(continued.stdout, /# Orchestration request/);
  } finally {
    cleanup(retry);
  }
});
