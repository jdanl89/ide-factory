import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { getAttempt } from '../src/lib/attempt.mjs';
import {
  validateScopedApproval,
  writeScopedApproval,
} from '../src/lib/risk-gates.mjs';
import { readRunSession } from '../src/lib/run-session.mjs';
import { getWorkItem } from '../src/lib/work.mjs';
import { cleanup, idefactory, repoRoot, tempProject } from './helpers.mjs';

const IMPLEMENTER = 'bc-engineer-1';
const APPROVER = 'bc-approver-9';
const SECURITY_REVIEWER = 'bc-security-reviewer-1';
const HOUR_MS = 60 * 60 * 1000;

function validApproval(overrides = {}) {
  const issuance = '2026-10-21T18:00:00.000Z';
  return {
    schemaVersion: 1,
    change: 'enforce-risk-gates-and-security-stage',
    task: '1.1',
    sourceRevision: 'abc123def456',
    action: 'accept',
    approver: APPROVER,
    issuance,
    expiry: new Date(Date.parse(issuance) + 12 * HOUR_MS).toISOString(),
    policyVersion: 1,
    note: 'scoped accept',
    ...overrides,
  };
}

function approvalFiles(dir) {
  const root = path.join(dir, '.factory', 'approvals');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((name) => name !== '.gitkeep');
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

function ensureCleanGitCommit(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'idefactory-test']);
  }
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
  return git(dir, ['rev-parse', 'HEAD']);
}

function scopeFlags(overrides = {}) {
  const expiry = new Date(Date.now() + 12 * HOUR_MS).toISOString();
  return {
    change: 'enforce-risk-gates-and-security-stage',
    task: '1.2',
    action: 'accept',
    approver: APPROVER,
    expiry,
    ...overrides,
  };
}

function approveArgs(id, note, scope) {
  const args = ['approve', id, '--note', note];
  for (const [key, value] of Object.entries(scope)) {
    if (value === undefined) continue;
    args.push(`--${key}`, String(value));
  }
  return args;
}

function setPolicyVersion(dir, version) {
  const configPath = path.join(dir, '.factory/config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.governance.policyVersion = version;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function decisionsText(dir) {
  return fs.readFileSync(path.join(dir, '.factory', 'decisions.md'), 'utf8');
}

test('schema version 1 approval records required scope fields', () => {
  const input = validApproval({ action: 'complete' });
  const approval = validateScopedApproval(input, { implementerId: IMPLEMENTER });

  assert.equal(approval.schemaVersion, 1);
  assert.equal(approval.change, 'enforce-risk-gates-and-security-stage');
  assert.equal(approval.task, '1.1');
  assert.equal(approval.sourceRevision, 'abc123def456');
  assert.equal(approval.action, 'complete');
  assert.equal(approval.approver, APPROVER);
  assert.equal(approval.issuance, input.issuance);
  assert.equal(approval.expiry, input.expiry);
  assert.equal(approval.policyVersion, 1);
});

test('missing scope field is rejected without writing a file', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const before = approvalFiles(dir);
    const fields = [
      'schemaVersion',
      'change',
      'task',
      'sourceRevision',
      'action',
      'approver',
      'issuance',
      'expiry',
      'policyVersion',
    ];
    for (const field of fields) {
      const input = validApproval();
      delete input[field];
      assert.throws(
        () => writeScopedApproval(dir, 'missing-field', input, { implementerId: IMPLEMENTER }),
        /missing|required|scope|field/i,
        `expected rejection for missing ${field}`,
      );
    }
    assert.deepEqual(approvalFiles(dir), before);
  } finally {
    cleanup(dir);
  }
});

test('action other than accept or complete is rejected without writing a file', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const before = approvalFiles(dir);
    assert.throws(
      () => writeScopedApproval(
        dir,
        'bad-action',
        validApproval({ action: 'reject' }),
        { implementerId: IMPLEMENTER },
      ),
      /action|accept|complete/i,
    );
    assert.deepEqual(approvalFiles(dir), before);
  } finally {
    cleanup(dir);
  }
});

test('expiry more than 24 hours after issuance is rejected without writing a file', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const before = approvalFiles(dir);
    const issuance = '2026-10-21T18:00:00.000Z';
    assert.throws(
      () => writeScopedApproval(
        dir,
        'too-long',
        validApproval({
          issuance,
          expiry: new Date(Date.parse(issuance) + 24 * HOUR_MS + 1).toISOString(),
        }),
        { implementerId: IMPLEMENTER },
      ),
      /expir|24|lifetime|hours/i,
    );
    assert.deepEqual(approvalFiles(dir), before);
  } finally {
    cleanup(dir);
  }
});

test('approver equal to implementer is rejected without writing a file', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const before = approvalFiles(dir);
    assert.throws(
      () => writeScopedApproval(
        dir,
        'self-approve',
        validApproval({ approver: IMPLEMENTER }),
        { implementerId: IMPLEMENTER },
      ),
      /approver|implementer/i,
    );
    assert.deepEqual(approvalFiles(dir), before);
  } finally {
    cleanup(dir);
  }
});

test('approve with id, note, and every scope field writes JSON and appends decisions', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    setPolicyVersion(dir, 1);
    const head = ensureCleanGitCommit(dir);
    const beforeDecisions = decisionsText(dir);
    const id = 'scoped-accept-ok';
    const note = 'human accepts this step';
    const scope = scopeFlags();
    const result = await idefactory(dir, approveArgs(id, note, scope));
    assert.equal(result.code, 0, result.err + result.out);

    const jsonPath = path.join(dir, '.factory', 'approvals', `${id}.json`);
    assert.equal(fs.existsSync(jsonPath), true, 'expected JSON approval file');
    const written = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.equal(written.note, note);
    assert.equal(written.change, scope.change);
    assert.equal(written.task, scope.task);
    assert.equal(written.action, scope.action);
    assert.equal(written.approver, scope.approver);
    assert.equal(written.expiry, scope.expiry);
    assert.equal(written.sourceRevision, head);
    assert.equal(written.schemaVersion, 1);
    assert.equal(written.policyVersion, 1);
    assert.equal(typeof written.issuance, 'string');
    assert.match(decisionsText(dir), new RegExp(id));
    assert.notEqual(decisionsText(dir), beforeDecisions);
  } finally {
    cleanup(dir);
  }
});

test('approve with id and note but a scope field omitted writes nothing', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    ensureCleanGitCommit(dir);
    const beforeFiles = approvalFiles(dir);
    const beforeDecisions = decisionsText(dir);
    const id = 'incomplete-scope';
    const scope = scopeFlags();
    delete scope.task;
    const result = await idefactory(dir, approveArgs(id, 'note only incomplete', scope));
    assert.notEqual(result.code, 0);
    assert.deepEqual(approvalFiles(dir), beforeFiles);
    assert.equal(decisionsText(dir), beforeDecisions);
    assert.equal(fs.existsSync(path.join(dir, '.factory', 'approvals', `${id}.json`)), false);
  } finally {
    cleanup(dir);
  }
});

test('approve on a dirty non-run-state tree writes nothing', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    ensureCleanGitCommit(dir);
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'uncommitted source\n');
    const beforeFiles = approvalFiles(dir);
    const beforeDecisions = decisionsText(dir);
    const id = 'dirty-tree';
    const result = await idefactory(dir, approveArgs(id, 'should refuse', scopeFlags()));
    assert.notEqual(result.code, 0);
    assert.deepEqual(approvalFiles(dir), beforeFiles);
    assert.equal(decisionsText(dir), beforeDecisions);
    assert.equal(fs.existsSync(path.join(dir, '.factory', 'approvals', `${id}.json`)), false);
  } finally {
    cleanup(dir);
  }
});

function listRunSessionFiles(project) {
  const runsDir = path.join(project, '.factory', 'orchestration', 'runs');
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(runsDir, name));
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
    '.factory/approvals/*',
    '!.factory/approvals/.gitkeep',
  ];
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const extras = lines.filter((line) => !existing.split('\n').includes(line));
  if (extras.length > 0) {
    fs.writeFileSync(file, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${extras.join('\n')}\n`);
  }
}

function plantApproval(dir, id, overrides = {}) {
  const head = git(dir, ['rev-parse', 'HEAD']);
  const issuance = new Date(Date.now() - HOUR_MS).toISOString();
  const record = validApproval({
    change: 'demo',
    task: '2.2',
    sourceRevision: head,
    action: 'accept',
    approver: APPROVER,
    issuance,
    expiry: new Date(Date.now() + 12 * HOUR_MS).toISOString(),
    policyVersion: 1,
    note: 'planted scoped approval',
    ...overrides,
  });
  return writeScopedApproval(dir, id, record, { implementerId: IMPLEMENTER });
}

async function advanceToVerifying(dir, attemptId) {
  await recordRed(dir, attemptId);
  assert.equal((await idefactory(dir, [
    'attempt', 'transition', attemptId, 'implementing',
    '--evidence', JSON.stringify({ implementerId: IMPLEMENTER }),
  ])).code, 0);
  assert.equal((await idefactory(dir, [
    'attempt', 'transition', attemptId, 'red-confirmed',
    '--evidence', JSON.stringify({}),
  ])).code, 0);
  await recordPassingChecks(dir, attemptId);
  assert.equal((await idefactory(dir, [
    'attempt', 'transition', attemptId, 'verifying',
    '--evidence', JSON.stringify({}),
  ])).code, 0);
}

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
    path.join(dir, '.factory', 'checks.json'),
    `${JSON.stringify({ schemaVersion: 1, checks }, null, 2)}\n`,
  );
}

function patchProfiles(dir, mutator) {
  const file = path.join(dir, '.factory', 'profiles.json');
  const profiles = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutator(profiles);
  fs.writeFileSync(file, `${JSON.stringify(profiles, null, 2)}\n`);
}

async function seedGatedChange(dir, {
  verificationProfile = 'frontend-low',
  taskId = '2.1',
} = {}) {
  assert.equal((await idefactory(dir, ['init'])).code, 0);
  setPolicyVersion(dir, 1);
  fs.mkdirSync(path.join(dir, 'openspec/changes/demo'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'openspec/changes/demo/tasks.md'),
    [
      `- [ ] ${taskId} Human gate item`,
      '  factory:',
      '    kind: general',
      '    checks: [unit]',
      `    verificationProfile: ${verificationProfile}`,
      '    roles: [engineer, reviewer, scribe]',
      '',
    ].join('\n'),
  );
  assert.equal((await idefactory(dir, ['sync-tasks', 'demo'])).code, 0);
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
  ensureFactoryGitignore(dir);
  ensureCleanGitCommit(dir);
  const result = await idefactory(dir, ['verify', 'run', attemptId, '--check', 'unit']);
  assert.equal(result.code, 0, result.err + result.out);
}

async function advanceToAwaitingReview(dir, attemptId) {
  await recordRed(dir, attemptId);
  assert.equal((await idefactory(dir, [
    'attempt', 'transition', attemptId, 'implementing',
    '--evidence', JSON.stringify({ implementerId: IMPLEMENTER }),
  ])).code, 0);
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
}

async function acceptViaTransitions(dir, attemptId) {
  await advanceToAwaitingReview(dir, attemptId);
  assert.equal((await idefactory(dir, [
    'attempt', 'transition', attemptId, 'accepted',
    '--evidence', JSON.stringify({ reviewerId: APPROVER, verdict: 'ACCEPT' }),
  ])).code, 0);
}

test('humanGate true without accept approval stops run with human-gate and open session', async () => {
  const dir = tempProject();
  try {
    await seedGatedChange(dir, { verificationProfile: 'frontend-low', taskId: '2.1' });
    patchProfiles(dir, (profiles) => {
      profiles['frontend-low'].humanGate = true;
    });
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '2.1']);
    assert.equal(started.code, 0, started.err + started.out);
    const attemptId = JSON.parse(started.out).id;
    await advanceToAwaitingReview(dir, attemptId);

    const result = await idefactory(dir, [
      'run', '--change', 'demo', '--max-tasks', '1', '--max-agent-steps', '10',
    ]);
    assert.equal(result.code, 0, result.err + result.out);
    assert.match(result.out, /Run stopped \(human-gate\)/);
    assert.doesNotMatch(result.out, /# Orchestration request/);
    assert.doesNotMatch(result.out, /```json/);

    const sessions = listRunSessionFiles(dir);
    assert.equal(sessions.length, 1);
    const session = readRunSession(sessions[0]);
    assert.equal(session.status, 'open');
    assert.notEqual(session.status, 'closed');
  } finally {
    cleanup(dir);
  }
});

test('complete without complete approval exits non-zero and leaves item undone', async () => {
  const dir = tempProject();
  try {
    await seedGatedChange(dir, { verificationProfile: 'frontend-low', taskId: '2.1' });
    patchProfiles(dir, (profiles) => {
      profiles['frontend-low'].humanGate = true;
    });
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '2.1']);
    assert.equal(started.code, 0, started.err + started.out);
    const attemptId = JSON.parse(started.out).id;
    await acceptViaTransitions(dir, attemptId);

    const beforeStatus = getWorkItem(dir, 'demo', '2.1').status;
    const done = await idefactory(dir, ['complete', 'demo', '2.1', '--attempt', attemptId]);
    assert.notEqual(done.code, 0, `expected complete to fail; stdout=${done.out}`);
    assert.match(done.err, /human.?gate|approval|complete/i);
    assert.equal(getWorkItem(dir, 'demo', '2.1').status, beforeStatus);
    assert.notEqual(getWorkItem(dir, 'demo', '2.1').status, 'done');
    assert.notEqual(getAttempt(dir, attemptId).state, 'finalized');
  } finally {
    cleanup(dir);
  }
});

test('missing verification profile is treated as humanGate true', async () => {
  const dir = tempProject();
  try {
    await seedGatedChange(dir, { verificationProfile: 'no-such-profile', taskId: '2.1' });
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '2.1']);
    assert.equal(started.code, 0, started.err + started.out);
    const attemptId = JSON.parse(started.out).id;
    await advanceToAwaitingReview(dir, attemptId);

    const result = await idefactory(dir, [
      'run', '--change', 'demo', '--max-tasks', '1', '--max-agent-steps', '10',
    ]);
    assert.equal(result.code, 0, result.err + result.out);
    assert.match(result.out, /Run stopped \(human-gate\)/);
    assert.doesNotMatch(result.out, /# Orchestration request/);
    const session = readRunSession(listRunSessionFiles(dir)[0]);
    assert.equal(session.status, 'open');
  } finally {
    cleanup(dir);
  }
});

test('non-boolean humanGate is treated as true', async () => {
  const dir = tempProject();
  try {
    await seedGatedChange(dir, { verificationProfile: 'frontend-low', taskId: '2.1' });
    patchProfiles(dir, (profiles) => {
      profiles['frontend-low'].humanGate = 'yes';
    });
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '2.1']);
    assert.equal(started.code, 0, started.err + started.out);
    const attemptId = JSON.parse(started.out).id;
    await advanceToAwaitingReview(dir, attemptId);

    const result = await idefactory(dir, [
      'run', '--change', 'demo', '--max-tasks', '1', '--max-agent-steps', '10',
    ]);
    assert.equal(result.code, 0, result.err + result.out);
    assert.match(result.out, /Run stopped \(human-gate\)/);
    assert.doesNotMatch(result.out, /# Orchestration request/);
    const session = readRunSession(listRunSessionFiles(dir)[0]);
    assert.equal(session.status, 'open');
  } finally {
    cleanup(dir);
  }
});

test('matching accept approval allows accept transition via run', async () => {
  const dir = tempProject();
  try {
    await seedGatedChange(dir, { verificationProfile: 'frontend-low', taskId: '2.2' });
    patchProfiles(dir, (profiles) => {
      profiles['frontend-low'].humanGate = true;
    });
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '2.2']);
    assert.equal(started.code, 0, started.err + started.out);
    const attemptId = JSON.parse(started.out).id;
    await advanceToAwaitingReview(dir, attemptId);
    plantApproval(dir, 'accept-ok', { action: 'accept', task: '2.2' });

    const result = await idefactory(dir, [
      'run', '--change', 'demo', '--max-tasks', '1', '--max-agent-steps', '10',
    ]);
    assert.equal(result.code, 2, result.err + result.out);
    assert.match(result.out, /# Orchestration request/);
    assert.match(result.out, /"nextState": "accepted"/);
    assert.doesNotMatch(result.out, /Run stopped \(human-gate\)/);
  } finally {
    cleanup(dir);
  }
});

test('matching complete approval allows completion', async () => {
  const dir = tempProject();
  try {
    await seedGatedChange(dir, { verificationProfile: 'frontend-low', taskId: '2.2' });
    patchProfiles(dir, (profiles) => {
      profiles['frontend-low'].humanGate = true;
    });
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '2.2']);
    assert.equal(started.code, 0, started.err + started.out);
    const attemptId = JSON.parse(started.out).id;
    await acceptViaTransitions(dir, attemptId);
    plantApproval(dir, 'complete-ok', { action: 'complete', task: '2.2' });

    const done = await idefactory(dir, ['complete', 'demo', '2.2', '--attempt', attemptId]);
    assert.equal(done.code, 0, done.err + done.out);
    assert.equal(getWorkItem(dir, 'demo', '2.2').status, 'done');
    assert.equal(getAttempt(dir, attemptId).state, 'finalized');
  } finally {
    cleanup(dir);
  }
});

test('wrong action, wrong task, stale revision, expired, or policy mismatch do not authorize', async () => {
  const dir = tempProject();
  try {
    await seedGatedChange(dir, { verificationProfile: 'frontend-low', taskId: '2.2' });
    patchProfiles(dir, (profiles) => {
      profiles['frontend-low'].humanGate = true;
    });
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '2.2']);
    assert.equal(started.code, 0, started.err + started.out);
    const attemptId = JSON.parse(started.out).id;
    await advanceToAwaitingReview(dir, attemptId);

    const mismatches = [
      { id: 'wrong-action', overrides: { action: 'complete' } },
      { id: 'wrong-task', overrides: { task: '9.9' } },
      { id: 'stale-rev', overrides: { sourceRevision: '0'.repeat(40) } },
      {
        id: 'expired',
        overrides: {
          issuance: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
          expiry: new Date(Date.now() - HOUR_MS).toISOString(),
        },
      },
      { id: 'policy-mismatch', overrides: { policyVersion: 99 } },
    ];

    for (const { id, overrides } of mismatches) {
      for (const name of approvalFiles(dir).filter((n) => n.endsWith('.json'))) {
        fs.unlinkSync(path.join(dir, '.factory', 'approvals', name));
      }
      plantApproval(dir, id, { action: 'accept', task: '2.2', ...overrides });

      const result = await idefactory(dir, [
        'run', '--change', 'demo', '--max-tasks', '1', '--max-agent-steps', '10',
      ]);
      assert.equal(result.code, 0, `${id}: ${result.err + result.out}`);
      assert.match(result.out, /Run stopped \(human-gate\)/, `${id} should stay gated`);
      assert.doesNotMatch(result.out, /# Orchestration request/, `${id} must not emit request`);
    }
  } finally {
    cleanup(dir);
  }
});

test('humanGate false on non-sensitive work reaches review without approval', async () => {
  const dir = tempProject();
  try {
    await seedGatedChange(dir, { verificationProfile: 'frontend-low', taskId: '2.2' });
    patchProfiles(dir, (profiles) => {
      profiles['frontend-low'].humanGate = false;
    });
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '2.2']);
    assert.equal(started.code, 0, started.err + started.out);
    const attemptId = JSON.parse(started.out).id;
    await advanceToVerifying(dir, attemptId);

    assert.equal(approvalFiles(dir).filter((n) => n.endsWith('.json')).length, 0);
    const result = await idefactory(dir, [
      'run', '--change', 'demo', '--max-tasks', '1', '--max-agent-steps', '10',
    ]);
    assert.equal(result.code, 2, result.err + result.out);
    assert.match(result.out, /# Orchestration request/);
    assert.match(result.out, /"role": "reviewer"/);
    assert.match(result.out, /"nextState": "awaiting-review"/);
    assert.doesNotMatch(result.out, /Run stopped \(human-gate\)/);
  } finally {
    cleanup(dir);
  }
});

async function seedSecurityStageChange(dir, {
  taskId = '3.1',
  securityProfile = 'security-sensitive',
  verificationProfile = 'frontend-low',
  checks = ['unit'],
  roles = ['engineer', 'security-reviewer', 'reviewer', 'scribe'],
} = {}) {
  assert.equal((await idefactory(dir, ['init'])).code, 0);
  setPolicyVersion(dir, 1);
  fs.mkdirSync(path.join(dir, 'openspec/changes/demo'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'openspec/changes/demo/tasks.md'),
    [
      `- [ ] ${taskId} Stage fixture`,
      '  factory:',
      '    kind: general',
      `    checks: [${checks.join(', ')}]`,
      `    securityProfile: ${securityProfile}`,
      `    verificationProfile: ${verificationProfile}`,
      `    roles: [${roles.join(', ')}]`,
      '',
    ].join('\n'),
  );
  assert.equal((await idefactory(dir, ['sync-tasks', 'demo'])).code, 0);
}

test('security-sensitive work rejects verifying to awaiting-review and stays verifying', async () => {
  const dir = tempProject();
  try {
    await seedSecurityStageChange(dir, {
      taskId: '3.1',
      securityProfile: 'security-sensitive',
      verificationProfile: 'frontend-low',
      checks: ['unit'],
    });
    const item = getWorkItem(dir, 'demo', '3.1');
    assert.equal(item.factory?.securityProfile, 'security-sensitive');
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '3.1']);
    assert.equal(started.code, 0, started.err + started.out);
    const attemptId = JSON.parse(started.out).id;
    await advanceToVerifying(dir, attemptId);

    const beforeRaw = fs.readFileSync(
      path.join(dir, '.factory', 'attempts', `${attemptId}.json`),
      'utf8',
    );
    const bad = await idefactory(dir, [
      'attempt', 'transition', attemptId, 'awaiting-review',
      '--evidence', JSON.stringify({}),
    ]);
    assert.notEqual(bad.code, 0, bad.err + bad.out);
    assert.match(bad.err, /security|awaiting-review|verifying/i);
    assert.equal(getAttempt(dir, attemptId).state, 'verifying');
    assert.equal(
      fs.readFileSync(path.join(dir, '.factory', 'attempts', `${attemptId}.json`), 'utf8'),
      beforeRaw,
    );
  } finally {
    cleanup(dir);
  }
});

test('verificationProfile alone does not require the security stage', async () => {
  const dir = tempProject();
  try {
    await seedSecurityStageChange(dir, {
      taskId: '3.1',
      securityProfile: 'dependency-basic',
      verificationProfile: 'security-sensitive',
      checks: ['unit'],
      roles: ['engineer', 'reviewer', 'scribe'],
    });
    const item = getWorkItem(dir, 'demo', '3.1');
    assert.equal(item.factory?.verificationProfile, 'security-sensitive');
    assert.notEqual(item.factory?.securityProfile, 'security-sensitive');
    assert.equal((item.factory?.checks || []).some((c) => /security|sast|threat|secret|audit/i.test(c)), false);

    const started = await idefactory(dir, ['attempt', 'start', 'demo', '3.1']);
    assert.equal(started.code, 0, started.err + started.out);
    const attemptId = JSON.parse(started.out).id;
    await advanceToVerifying(dir, attemptId);

    const ok = await idefactory(dir, [
      'attempt', 'transition', attemptId, 'awaiting-review',
      '--evidence', JSON.stringify({}),
    ]);
    assert.equal(ok.code, 0, ok.err + ok.out);
    assert.equal(getAttempt(dir, attemptId).state, 'awaiting-review');
  } finally {
    cleanup(dir);
  }
});

test('security-sensitive verifying still requests security-reviewer on next run', async () => {
  const dir = tempProject();
  try {
    await seedSecurityStageChange(dir, {
      taskId: '3.1',
      securityProfile: 'security-sensitive',
      verificationProfile: 'frontend-low',
      checks: ['unit'],
    });
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '3.1']);
    assert.equal(started.code, 0, started.err + started.out);
    const attemptId = JSON.parse(started.out).id;
    await advanceToVerifying(dir, attemptId);

    const bypass = await idefactory(dir, [
      'attempt', 'transition', attemptId, 'awaiting-review',
      '--evidence', JSON.stringify({}),
    ]);
    assert.notEqual(bypass.code, 0);
    assert.equal(getAttempt(dir, attemptId).state, 'verifying');

    const result = await idefactory(dir, [
      'run', '--change', 'demo', '--max-tasks', '1', '--max-agent-steps', '10',
    ]);
    assert.equal(result.code, 2, result.err + result.out);
    assert.match(result.out, /^Role: security-reviewer$/m);
    assert.match(result.out, /"role": "security-reviewer"/);
    assert.match(result.out, /"nextState": "security-checking"/);
    assert.doesNotMatch(result.out, /^Role: reviewer$/m);
  } finally {
    cleanup(dir);
  }
});

async function advanceToSecurityChecking(dir, attemptId) {
  await advanceToVerifying(dir, attemptId);
  assert.equal((await idefactory(dir, [
    'attempt', 'transition', attemptId, 'security-checking',
    '--evidence', JSON.stringify({}),
  ])).code, 0);
  assert.equal(getAttempt(dir, attemptId).state, 'security-checking');
}

async function recordPassingSecurityCheck(dir, attemptId, kind = 'threat-review') {
  writeCheckRegistry(dir, { unit: 0, [kind]: 0 });
  ensureFactoryGitignore(dir);
  ensureCleanGitCommit(dir);
  const result = await idefactory(dir, ['verify', 'run', attemptId, '--check', kind]);
  assert.equal(result.code, 0, result.err + result.out);
  return getAttempt(dir, attemptId);
}

test('security-checking to awaiting-review rejected without passing CLI security record', async () => {
  const dir = tempProject();
  try {
    await seedSecurityStageChange(dir, {
      taskId: '3.2',
      securityProfile: 'security-sensitive',
      verificationProfile: 'frontend-low',
      checks: ['unit'],
    });
    const shipped = JSON.parse(
      fs.readFileSync(path.join(dir, '.factory', 'checks.json'), 'utf8'),
    );
    assert.equal(shipped.checks.unit, undefined);
    assert.equal(shipped.checks['threat-review'], undefined);

    const started = await idefactory(dir, ['attempt', 'start', 'demo', '3.2']);
    assert.equal(started.code, 0, started.err + started.out);
    const attemptId = JSON.parse(started.out).id;
    await advanceToSecurityChecking(dir, attemptId);

    const beforeRaw = fs.readFileSync(
      path.join(dir, '.factory', 'attempts', `${attemptId}.json`),
      'utf8',
    );
    const bad = await idefactory(dir, [
      'attempt', 'transition', attemptId, 'awaiting-review',
      '--evidence', JSON.stringify({}),
    ]);
    assert.notEqual(bad.code, 0, bad.err + bad.out);
    assert.match(bad.err, /security|threat-review|evidence/i);
    assert.equal(getAttempt(dir, attemptId).state, 'security-checking');
    assert.equal(
      fs.readFileSync(path.join(dir, '.factory', 'attempts', `${attemptId}.json`), 'utf8'),
      beforeRaw,
    );
  } finally {
    cleanup(dir);
  }
});

test('passing CLI security record bound to attempt and clean revision allows awaiting-review', async () => {
  const dir = tempProject();
  try {
    await seedSecurityStageChange(dir, {
      taskId: '3.2',
      securityProfile: 'security-sensitive',
      verificationProfile: 'frontend-low',
      checks: ['unit'],
    });
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '3.2']);
    assert.equal(started.code, 0, started.err + started.out);
    const attemptId = JSON.parse(started.out).id;
    await advanceToSecurityChecking(dir, attemptId);

    const afterVerify = await recordPassingSecurityCheck(dir, attemptId, 'threat-review');
    const security = afterVerify.evidence.security || [];
    assert.equal(security.length, 1);
    assert.equal(security[0].kind, 'threat-review');
    assert.equal(security[0].issuer, 'cli');
    assert.equal(security[0].exitCode, 0);
    assert.equal(security[0].attemptId, attemptId);
    assert.equal(security[0].passed, true);
    assert.equal((afterVerify.evidence.verification || []).some((r) => r.kind === 'threat-review'), false);

    const ok = await idefactory(dir, [
      'attempt', 'transition', attemptId, 'awaiting-review',
      '--evidence', JSON.stringify({
        verdict: 'ACCEPT',
        securityReviewerId: SECURITY_REVIEWER,
      }),
    ]);
    assert.equal(ok.code, 0, ok.err + ok.out);
    assert.equal(getAttempt(dir, attemptId).state, 'awaiting-review');
  } finally {
    cleanup(dir);
  }
});

test('recorded red security result does not authorize awaiting-review', async () => {
  const dir = tempProject();
  try {
    await seedSecurityStageChange(dir, {
      taskId: '3.2',
      securityProfile: 'security-sensitive',
      verificationProfile: 'frontend-low',
      checks: ['unit'],
    });
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '3.2']);
    assert.equal(started.code, 0, started.err + started.out);
    const attemptId = JSON.parse(started.out).id;
    await advanceToSecurityChecking(dir, attemptId);

    writeCheckRegistry(dir, { unit: 0, 'threat-review': 1 });
    ensureFactoryGitignore(dir);
    ensureCleanGitCommit(dir);
    const red = await idefactory(dir, [
      'verify', 'run', attemptId, '--check', 'threat-review', '--red',
    ]);
    assert.equal(red.code, 0, red.err + red.out);
    const attempt = getAttempt(dir, attemptId);
    assert.ok(attempt.evidence.reds?.['threat-review']);
    assert.equal(attempt.evidence.reds['threat-review'].kind, 'threat-review');
    assert.equal(attempt.evidence.reds['threat-review'].exitCode, 1);
    assert.equal(attempt.evidence.reds['threat-review'].passed, false);
    assert.equal((attempt.evidence.security || []).length, 0);

    const beforeRaw = fs.readFileSync(
      path.join(dir, '.factory', 'attempts', `${attemptId}.json`),
      'utf8',
    );
    const bad = await idefactory(dir, [
      'attempt', 'transition', attemptId, 'awaiting-review',
      '--evidence', JSON.stringify({}),
    ]);
    assert.notEqual(bad.code, 0, bad.err + bad.out);
    assert.match(bad.err, /security|threat-review|evidence|red/i);
    assert.equal(getAttempt(dir, attemptId).state, 'security-checking');
    assert.equal(
      fs.readFileSync(path.join(dir, '.factory', 'attempts', `${attemptId}.json`), 'utf8'),
      beforeRaw,
    );
  } finally {
    cleanup(dir);
  }
});

test('caller-supplied security payload is rejected on security-checking transition', async () => {
  const dir = tempProject();
  try {
    await seedSecurityStageChange(dir, {
      taskId: '3.2',
      securityProfile: 'security-sensitive',
      verificationProfile: 'frontend-low',
      checks: ['unit'],
    });
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '3.2']);
    assert.equal(started.code, 0, started.err + started.out);
    const attemptId = JSON.parse(started.out).id;
    await advanceToSecurityChecking(dir, attemptId);

    const beforeRaw = fs.readFileSync(
      path.join(dir, '.factory', 'attempts', `${attemptId}.json`),
      'utf8',
    );
    const bad = await idefactory(dir, [
      'attempt', 'transition', attemptId, 'awaiting-review',
      '--evidence', JSON.stringify({
        security: [{
          kind: 'threat-review',
          issuer: 'cli',
          exitCode: 0,
          passed: true,
          attemptId,
        }],
      }),
    ]);
    assert.notEqual(bad.code, 0, bad.err + bad.out);
    assert.match(bad.err, /caller-supplied|security|check result/i);
    assert.equal(getAttempt(dir, attemptId).state, 'security-checking');
    assert.equal(
      fs.readFileSync(path.join(dir, '.factory', 'attempts', `${attemptId}.json`), 'utf8'),
      beforeRaw,
    );
  } finally {
    cleanup(dir);
  }
});

test('default required security kind is threat-review when no security-patterned check', async () => {
  const dir = tempProject();
  try {
    await seedSecurityStageChange(dir, {
      taskId: '3.2',
      securityProfile: 'security-sensitive',
      verificationProfile: 'frontend-low',
      checks: ['unit'],
    });
    const item = getWorkItem(dir, 'demo', '3.2');
    assert.equal(item.factory?.securityProfile, 'security-sensitive');
    assert.equal(
      (item.factory?.checks || []).some((c) => /security|sast|threat|secret|audit/i.test(c)),
      false,
    );

    const started = await idefactory(dir, ['attempt', 'start', 'demo', '3.2']);
    assert.equal(started.code, 0, started.err + started.out);
    const attemptId = JSON.parse(started.out).id;
    await advanceToSecurityChecking(dir, attemptId);

    // A temporary non-threat security-kind pass must not satisfy the default threat-review requirement.
    writeCheckRegistry(dir, { unit: 0, sast: 0 });
    ensureFactoryGitignore(dir);
    ensureCleanGitCommit(dir);
    const sast = await idefactory(dir, ['verify', 'run', attemptId, '--check', 'sast']);
    assert.equal(sast.code, 0, sast.err + sast.out);
    assert.equal(getAttempt(dir, attemptId).evidence.security?.[0]?.kind, 'sast');

    const stillBlocked = await idefactory(dir, [
      'attempt', 'transition', attemptId, 'awaiting-review',
      '--evidence', JSON.stringify({}),
    ]);
    assert.notEqual(stillBlocked.code, 0, stillBlocked.err + stillBlocked.out);
    assert.match(stillBlocked.err, /threat-review/i);
    assert.equal(getAttempt(dir, attemptId).state, 'security-checking');

    await recordPassingSecurityCheck(dir, attemptId, 'threat-review');
    const ok = await idefactory(dir, [
      'attempt', 'transition', attemptId, 'awaiting-review',
      '--evidence', JSON.stringify({
        verdict: 'ACCEPT',
        securityReviewerId: SECURITY_REVIEWER,
      }),
    ]);
    assert.equal(ok.code, 0, ok.err + ok.out);
    assert.equal(getAttempt(dir, attemptId).state, 'awaiting-review');
  } finally {
    cleanup(dir);
  }
});

test('complete refuses security-required work lacking CLI security evidence', async () => {
  const dir = tempProject();
  try {
    await seedSecurityStageChange(dir, {
      taskId: '3.2',
      securityProfile: 'security-sensitive',
      verificationProfile: 'frontend-low',
      checks: ['unit'],
    });
    patchProfiles(dir, (profiles) => {
      profiles['frontend-low'].humanGate = false;
    });
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '3.2']);
    assert.equal(started.code, 0, started.err + started.out);
    const attemptId = JSON.parse(started.out).id;
    await advanceToSecurityChecking(dir, attemptId);
    await recordPassingSecurityCheck(dir, attemptId, 'threat-review');
    assert.equal((await idefactory(dir, [
      'attempt', 'transition', attemptId, 'awaiting-review',
      '--evidence', JSON.stringify({
        verdict: 'ACCEPT',
        securityReviewerId: SECURITY_REVIEWER,
      }),
    ])).code, 0);
    assert.equal((await idefactory(dir, [
      'attempt', 'transition', attemptId, 'accepted',
      '--evidence', JSON.stringify({ reviewerId: APPROVER, verdict: 'ACCEPT' }),
    ])).code, 0);

    const attemptPath = path.join(dir, '.factory', 'attempts', `${attemptId}.json`);
    const accepted = JSON.parse(fs.readFileSync(attemptPath, 'utf8'));
    accepted.evidence.security = [];
    fs.writeFileSync(attemptPath, `${JSON.stringify(accepted, null, 2)}\n`);

    // Re-bind unit at the current clean HEAD so complete fails on missing security evidence,
    // not a stale verification attestation.
    writeCheckRegistry(dir, { unit: 0, 'threat-review': 0 });
    ensureFactoryGitignore(dir);
    ensureCleanGitCommit(dir);
    const unit = await idefactory(dir, ['verify', 'run', attemptId, '--check', 'unit']);
    assert.equal(unit.code, 0, unit.err + unit.out);
    assert.equal((getAttempt(dir, attemptId).evidence.security || []).length, 0);

    const done = await idefactory(dir, ['complete', 'demo', '3.2', '--attempt', attemptId]);
    assert.notEqual(done.code, 0, done.err + done.out);
    assert.match(done.err, /security|threat-review|evidence/i);
    assert.equal(getWorkItem(dir, 'demo', '3.2').status, 'in_progress');
    assert.notEqual(getAttempt(dir, attemptId).state, 'finalized');
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

function factoryRunSkillLoopSection(text) {
  const start = text.indexOf('## Loop');
  assert.notEqual(start, -1, 'factory-run skill must have a Loop section');
  const afterLoop = text.indexOf('\n## ', start + 1);
  return afterLoop === -1 ? text.slice(start) : text.slice(start, afterLoop);
}

test('shipped factory-run skill copies describe human-gate as profile humanGate stop', () => {
  for (const rel of FACTORY_RUN_SKILL_COPIES) {
    const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    assert.match(
      text,
      /human-gate[\s\S]{0,120}true profile `?humanGate`?|true profile `?humanGate`?[\s\S]{0,120}human-gate/,
      `${rel} must describe human-gate as the stop for a true profile humanGate`,
    );
    assert.doesNotMatch(
      text,
      /human-gate\s*\(release profile\)/i,
      `${rel} must not limit human-gate to the release profile alone`,
    );
    const loop = factoryRunSkillLoopSection(text);
    assert.doesNotMatch(loop, /--new-run/, `${rel} loop must not pass --new-run`);
  }
});

test('implementation notes record strict validate, npm test, and doctor', () => {
  const notesPath = path.join(
    repoRoot,
    'openspec/changes/archive/2026-10-22-enforce-risk-gates-and-security-stage/implementation-notes.md',
  );
  assert.ok(
    fs.existsSync(notesPath),
    `missing implementation notes: ${notesPath}`,
  );
  const notes = fs.readFileSync(notesPath, 'utf8');
  assert.match(notes, /npx openspec validate enforce-risk-gates-and-security-stage --strict/);
  assert.match(notes, /npm test/);
  assert.match(notes, /node src\/cli\.mjs doctor/);
});
