import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { attemptPath, getAttempt } from '../src/lib/attempt.mjs';
import {
  buildFinalizationPlan,
  createFinalizationJournal,
} from '../src/lib/finalization-recovery.mjs';
import { writeText } from '../src/lib/layout.mjs';
import { commandDigest } from '../src/lib/verification-evidence.mjs';
import { getWorkItem, itemPath } from '../src/lib/work.mjs';
import { cleanup, idefactory, tempProject } from './helpers.mjs';

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

/** Ignore factory run-state so verify/complete mutations do not dirty the worktree. */
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

/** Init git if needed and commit the full worktree so verifyRun can record a pass. */
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
  return git(dir, ['rev-parse', 'HEAD']);
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
    path.join(dir, '.factory/checks.json'),
    `${JSON.stringify({ schemaVersion: 1, checks }, null, 2)}\n`,
  );
}

function setPolicyVersion(dir, version) {
  const configPath = path.join(dir, '.factory/config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.governance.policyVersion = version;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

async function seedChange(dir, tasksBody) {
  assert.equal((await idefactory(dir, ['init'])).code, 0);
  setPolicyVersion(dir, 1);
  fs.mkdirSync(path.join(dir, 'openspec/changes/demo'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'openspec/changes/demo/tasks.md'),
    tasksBody || [
      '- [ ] 1.1 Add parser',
      '  factory:',
      '    kind: general',
      '    checks: [unit]',
      '    verificationProfile: frontend-low',
      '    roles: [engineer, reviewer, scribe]',
      '',
    ].join('\n'),
  );
  assert.equal((await idefactory(dir, ['sync-tasks', 'demo'])).code, 0);
}

async function recordRed(dir, attemptId, kinds = { unit: 1 }) {
  writeCheckRegistry(dir, kinds);
  const kind = Object.keys(kinds)[0];
  const result = await idefactory(dir, [
    'verify', 'run', attemptId, '--check', kind, '--red',
  ]);
  assert.equal(result.code, 0, result.err + result.out);
  assert.ok(getAttempt(dir, attemptId).evidence.reds?.[kind], 'verify --red must store red evidence');
}

async function recordPassingChecks(dir, attemptId, kinds = { unit: 0 }) {
  writeCheckRegistry(dir, kinds);
  ensureCleanGitCommit(dir);
  for (const kind of Object.keys(kinds)) {
    const result = await idefactory(dir, [
      'verify', 'run', attemptId, '--check', kind,
    ]);
    assert.equal(result.code, 0, result.err + result.out);
    const record = getAttempt(dir, attemptId).evidence.verification
      .find((entry) => entry.kind === kind);
    assert.equal(record?.passed, true, `verify run must store a pass for ${kind}`);
  }
}

async function advanceToVerifying(dir, attemptId, {
  implementerId = 'engineer-1',
  passChecks = { unit: 0 },
} = {}) {
  await recordRed(dir, attemptId, { unit: 1 });
  assert.equal((await idefactory(dir, [
    'attempt', 'transition', attemptId, 'implementing',
    '--evidence', JSON.stringify({ implementerId }),
  ])).code, 0);
  assert.equal((await idefactory(dir, [
    'attempt', 'transition', attemptId, 'red-confirmed',
    '--evidence', JSON.stringify({}),
  ])).code, 0);
  if (passChecks && Object.keys(passChecks).length > 0) {
    await recordPassingChecks(dir, attemptId, passChecks);
  }
  assert.equal((await idefactory(dir, [
    'attempt', 'transition', attemptId, 'verifying',
    '--evidence', JSON.stringify({}),
  ])).code, 0);
}

async function acceptAttempt(dir, attemptId, options = {}) {
  await advanceToVerifying(dir, attemptId, options);
  await idefactory(dir, [
    'attempt', 'transition', attemptId, 'awaiting-review',
    '--evidence', JSON.stringify({}),
  ]);
  const accepted = await idefactory(dir, [
    'attempt', 'transition', attemptId, 'accepted',
    '--evidence', JSON.stringify({ reviewerId: 'reviewer-1', verdict: 'ACCEPT' }),
  ]);
  assert.equal(accepted.code, 0, accepted.err);
}

function writeAttemptEvidence(dir, attemptId, patchEvidence) {
  const file = attemptPath(dir, attemptId);
  const attempt = JSON.parse(fs.readFileSync(file, 'utf8'));
  attempt.evidence = { ...attempt.evidence, ...patchEvidence };
  fs.writeFileSync(file, `${JSON.stringify(attempt, null, 2)}\n`);
}

async function assertCompleteLeavesUnfinished(dir, attemptId, errPattern) {
  const beforeStatus = getWorkItem(dir, 'demo', '1.1').status;
  const done = await idefactory(dir, ['complete', 'demo', '1.1', '--attempt', attemptId]);
  assert.notEqual(done.code, 0, `expected complete to fail; stdout=${done.out}`);
  assert.match(done.err, errPattern);
  assert.equal(getWorkItem(dir, 'demo', '1.1').status, beforeStatus);
  assert.notEqual(getWorkItem(dir, 'demo', '1.1').status, 'done');
  assert.notEqual(getAttempt(dir, attemptId).state, 'finalized');
}

function parseOrchestrationJson(out) {
  const match = out.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(match, 'orchestration request must include a json block');
  return JSON.parse(match[1]);
}

test('run emits one-role orchestration request without launching a model', async () => {
  const dir = tempProject();
  try {
    await seedChange(dir);
    const result = await idefactory(dir, ['run', '--change', 'demo', '--max-tasks', '1']);
    assert.equal(result.code, 2, result.err + result.out);
    assert.match(result.out, /Orchestration request/);
    assert.match(result.out, /^Role: engineer$/m);
    assert.match(result.out, /\.factory\/agents\/engineer\/charter\.md/);
    assert.match(result.out, /\.factory\/agents\/engineer\/history\.md/);
    assert.doesNotMatch(result.out, /\.factory\/agents\/reviewer\/charter\.md/);
    assert.doesNotMatch(result.out, /\.factory\/agents\/scribe\/charter\.md/);
    assert.doesNotMatch(result.out, /\.factory\/agents\/lead\/charter\.md/);
    const request = parseOrchestrationJson(result.out);
    assert.equal(request.action, 'agent-step');
    assert.equal(request.role, 'engineer');
    assert.ok(request.modelProfile);
    assert.equal(Object.keys(request).filter((key) => key === 'role').length, 1);
  } finally {
    cleanup(dir);
  }
});

test('security-sensitive verification routes to security-reviewer', async () => {
  const dir = tempProject();
  try {
    // Runtime routes on securityProfile or security-patterned checks (e.g. threat-review),
    // not on verificationProfile alone — see threat notes for this attempt.
    await seedChange(dir, [
      '- [ ] 1.1 Add parser',
      '  factory:',
      '    kind: general',
      '    checks: [unit, threat-review]',
      '    verificationProfile: security-sensitive',
      '    roles: [engineer, security-reviewer, reviewer, scribe]',
      '',
    ].join('\n'));
    const item = getWorkItem(dir, 'demo', '1.1');
    assert.ok(
      (item.factory?.checks || []).includes('threat-review')
        || item.factory?.securityProfile === 'security-sensitive',
      'fixture must trigger the security-reviewer stage via check or securityProfile',
    );
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
    assert.equal(started.code, 0, started.err);
    const attempt = JSON.parse(started.out);
    // Routing depends on work-item checks/profile and verifying state, not forged evidence.
    await advanceToVerifying(dir, attempt.id, { passChecks: {} });
    const result = await idefactory(dir, ['run', '--change', 'demo', '--max-tasks', '1']);
    assert.equal(result.code, 2, result.err + result.out);
    assert.match(result.out, /^Role: security-reviewer$/m);
    assert.match(result.out, /\.factory\/agents\/security-reviewer\/charter\.md/);
    assert.doesNotMatch(result.out, /\.factory\/agents\/reviewer\/charter\.md/);
    const request = parseOrchestrationJson(result.out);
    assert.equal(request.role, 'security-reviewer');
    assert.equal(request.state, 'verifying');
    assert.equal(request.nextState, 'security-checking');
    assert.equal(request.verificationProfile, 'security-sensitive');
  } finally {
    cleanup(dir);
  }
});

test('security-sensitive verifying rejects awaiting-review bypass; run still names security-reviewer', async () => {
  const dir = tempProject();
  try {
    await seedChange(dir, [
      '- [ ] 1.1 Add parser',
      '  factory:',
      '    kind: general',
      '    checks: [unit]',
      '    securityProfile: security-sensitive',
      '    verificationProfile: frontend-low',
      '    roles: [engineer, security-reviewer, reviewer, scribe]',
      '',
    ].join('\n'));
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
    assert.equal(started.code, 0, started.err);
    const attempt = JSON.parse(started.out);
    await advanceToVerifying(dir, attempt.id, { passChecks: {} });

    const bypass = await idefactory(dir, [
      'attempt', 'transition', attempt.id, 'awaiting-review',
      '--evidence', JSON.stringify({}),
    ]);
    assert.notEqual(bypass.code, 0, bypass.err + bypass.out);
    assert.match(bypass.err, /security|awaiting-review|verifying/i);
    assert.equal(getAttempt(dir, attempt.id).state, 'verifying');

    const result = await idefactory(dir, ['run', '--change', 'demo', '--max-tasks', '1']);
    assert.equal(result.code, 2, result.err + result.out);
    assert.match(result.out, /^Role: security-reviewer$/m);
    const request = parseOrchestrationJson(result.out);
    assert.equal(request.role, 'security-reviewer');
    assert.equal(request.state, 'verifying');
    assert.equal(request.nextState, 'security-checking');
  } finally {
    cleanup(dir);
  }
});

test('verificationProfile alone does not route to security-reviewer or block awaiting-review', async () => {
  const dir = tempProject();
  try {
    await seedChange(dir, [
      '- [ ] 1.1 Add parser',
      '  factory:',
      '    kind: general',
      '    checks: [unit]',
      '    securityProfile: dependency-basic',
      '    verificationProfile: security-sensitive',
      '    roles: [engineer, reviewer, scribe]',
      '',
    ].join('\n'));
    const item = getWorkItem(dir, 'demo', '1.1');
    assert.equal(item.factory?.verificationProfile, 'security-sensitive');
    assert.notEqual(item.factory?.securityProfile, 'security-sensitive');

    const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
    assert.equal(started.code, 0, started.err);
    const attempt = JSON.parse(started.out);
    await advanceToVerifying(dir, attempt.id, { passChecks: {} });

    const toReview = await idefactory(dir, [
      'attempt', 'transition', attempt.id, 'awaiting-review',
      '--evidence', JSON.stringify({}),
    ]);
    assert.equal(toReview.code, 0, toReview.err + toReview.out);
    assert.equal(getAttempt(dir, attempt.id).state, 'awaiting-review');
  } finally {
    cleanup(dir);
  }
});

test('security-reviewer route in fresh session after sticky unchanged-state with remaining budget', async () => {
  const dir = tempProject();
  try {
    await seedChange(dir, [
      '- [ ] 1.1 Add parser',
      '  factory:',
      '    kind: general',
      '    checks: [unit, threat-review]',
      '    securityProfile: security-sensitive',
      '    verificationProfile: security-sensitive',
      '    roles: [engineer, security-reviewer, reviewer, scribe]',
      '',
    ].join('\n'));
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
    assert.equal(started.code, 0, started.err);
    const attempt = JSON.parse(started.out);

    const maxAgentSteps = 10;
    const first = await idefactory(dir, ['run', '--change', 'demo', '--max-agent-steps', String(maxAgentSteps)]);
    assert.equal(first.code, 2, first.err + first.out);
    assert.match(first.out, /^Role: engineer$/m);

    const unchanged = await idefactory(dir, ['run', '--change', 'demo', '--max-agent-steps', String(maxAgentSteps)]);
    assert.equal(unchanged.code, 0, unchanged.err + unchanged.out);
    assert.match(`${unchanged.err}\n${unchanged.out}`, /unchanged-state/);
    assert.doesNotMatch(`${unchanged.err}\n${unchanged.out}`, /# Orchestration request/);

    await advanceToVerifying(dir, attempt.id, { passChecks: {} });

    const stickyResume = await idefactory(dir, ['run', '--change', 'demo', '--max-agent-steps', String(maxAgentSteps)]);
    assert.equal(stickyResume.code, 0, stickyResume.err + stickyResume.out);
    assert.match(`${stickyResume.err}\n${stickyResume.out}`, /unchanged-state/);
    assert.doesNotMatch(`${stickyResume.err}\n${stickyResume.out}`, /# Orchestration request/);

    const securityRun = await idefactory(dir, [
      'run', '--change', 'demo', '--max-agent-steps', String(maxAgentSteps), '--new-run',
    ]);
    assert.equal(securityRun.code, 2, securityRun.err + securityRun.out);
    const securityRoleLines = [...securityRun.out.matchAll(/^Role: security-reviewer$/gm)];
    assert.equal(securityRoleLines.length, 1, 'must print exactly one security-reviewer request');
    assert.match(securityRun.out, /\.factory\/agents\/security-reviewer\/charter\.md/);
    assert.doesNotMatch(securityRun.out, /\.factory\/agents\/reviewer\/charter\.md/);
    const request = parseOrchestrationJson(securityRun.out);
    assert.equal(request.role, 'security-reviewer');
    assert.equal(request.state, 'verifying');
    assert.equal(request.nextState, 'security-checking');
  } finally {
    cleanup(dir);
  }
});

test('illegal attempt transition from assigned to accepted fails', async () => {
  const dir = tempProject();
  try {
    await seedChange(dir);
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
    const attempt = JSON.parse(started.out);
    assert.equal(attempt.state, 'assigned');
    const bad = await idefactory(dir, [
      'attempt', 'transition', attempt.id, 'accepted',
      '--evidence', JSON.stringify({ reviewerId: 'reviewer-1' }),
    ]);
    assert.notEqual(bad.code, 0);
    assert.match(bad.err, /Illegal transition/i);
    assert.equal(getAttempt(dir, attempt.id).state, 'assigned');
  } finally {
    cleanup(dir);
  }
});

test('attempt transition rejects caller-supplied check results and still accepts reviewer notes', async () => {
  const dir = tempProject();
  try {
    await seedChange(dir);
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
    assert.equal(started.code, 0, started.err);
    const attempt = JSON.parse(started.out);

    async function assertRejectedUnchanged(nextState, evidence) {
      const before = structuredClone(getAttempt(dir, attempt.id));
      const beforeRaw = fs.readFileSync(
        path.join(dir, '.factory/attempts', `${attempt.id}.json`),
        'utf8',
      );
      const result = await idefactory(dir, [
        'attempt', 'transition', attempt.id, nextState,
        '--evidence', JSON.stringify(evidence),
      ]);
      assert.notEqual(result.code, 0, `expected reject for keys ${Object.keys(evidence).join(',')}`);
      assert.match(result.err, /red|verification|security|check result|evidence/i);
      assert.deepEqual(getAttempt(dir, attempt.id), before);
      assert.equal(
        fs.readFileSync(path.join(dir, '.factory/attempts', `${attempt.id}.json`), 'utf8'),
        beforeRaw,
      );
    }

    await assertRejectedUnchanged('implementing', {
      implementerId: 'engineer-1',
      verification: [{ kind: 'unit', command: 'npm test', passed: true }],
    });
    await assertRejectedUnchanged('implementing', {
      implementerId: 'engineer-1',
      security: [{ kind: 'threat-review', command: 'threat-review', passed: true }],
    });
    await assertRejectedUnchanged('implementing', {
      implementerId: 'engineer-1',
      red: { command: 'npm test', passed: false },
    });

    await recordRed(dir, attempt.id, { unit: 1 });
    assert.equal((await idefactory(dir, [
      'attempt', 'transition', attempt.id, 'implementing',
      '--evidence', JSON.stringify({ implementerId: 'engineer-1' }),
    ])).code, 0);

    // Payload red is rejected even when it looks valid and stored red already exists.
    await assertRejectedUnchanged('red-confirmed', {
      red: { command: 'npm test', passed: false, kind: 'unit', exitCode: 1 },
    });

    assert.equal((await idefactory(dir, [
      'attempt', 'transition', attempt.id, 'red-confirmed',
      '--evidence', JSON.stringify({}),
    ])).code, 0);
    await recordPassingChecks(dir, attempt.id, { unit: 0 });
    assert.equal((await idefactory(dir, [
      'attempt', 'transition', attempt.id, 'verifying',
      '--evidence', JSON.stringify({}),
    ])).code, 0);
    assert.equal((await idefactory(dir, [
      'attempt', 'transition', attempt.id, 'awaiting-review',
      '--evidence', JSON.stringify({}),
    ])).code, 0);

    await assertRejectedUnchanged('accepted', {
      reviewerId: 'reviewer-1',
      verdict: 'ACCEPT',
      notes: 'looks good',
      verification: [{ kind: 'unit', passed: true }],
    });

    const accepted = await idefactory(dir, [
      'attempt', 'transition', attempt.id, 'accepted',
      '--evidence', JSON.stringify({
        reviewerId: 'reviewer-1',
        verdict: 'ACCEPT',
        notes: 'reviewer notes only',
      }),
    ]);
    assert.equal(accepted.code, 0, accepted.err);
    const stored = getAttempt(dir, attempt.id);
    assert.equal(stored.state, 'accepted');
    assert.equal(stored.reviewerId, 'reviewer-1');
    assert.equal(stored.evidence.review?.notes, 'reviewer notes only');
    assert.equal(stored.implementerId, 'engineer-1');
    assert.ok(stored.evidence.reds?.unit);
    assert.equal(stored.evidence.reds.unit.issuer, 'cli');
    assert.notEqual(stored.evidence.reds.unit.passed, true);
    assert.equal(stored.evidence.verification.length, 1);
    assert.equal(stored.evidence.verification[0].passed, true);
    assert.equal(stored.evidence.verification[0].issuer, 'cli');
  } finally {
    cleanup(dir);
  }
});

test('complete refuses same implementer and reviewer', async () => {
  const dir = tempProject();
  try {
    await seedChange(dir);
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
    assert.equal(started.code, 0, started.err);
    const attempt = JSON.parse(started.out);
    await advanceToVerifying(dir, attempt.id, {
      implementerId: 'same-agent',
      passChecks: {},
    });
    await idefactory(dir, [
      'attempt', 'transition', attempt.id, 'awaiting-review',
      '--evidence', '{}',
    ]);
    await idefactory(dir, [
      'attempt', 'transition', attempt.id, 'accepted',
      '--evidence', JSON.stringify({ reviewerId: 'same-agent', verdict: 'ACCEPT' }),
    ]);
    const done = await idefactory(dir, ['complete', 'demo', '1.1', '--attempt', attempt.id]);
    assert.notEqual(done.code, 0);
    assert.match(done.err, /reviewer must differ/i);
    assert.equal(getWorkItem(dir, 'demo', '1.1').status, 'in_progress');
  } finally {
    cleanup(dir);
  }
});

test('complete refuses missing verification evidence', async () => {
  const dir = tempProject();
  try {
    await seedChange(dir);
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
    const attempt = JSON.parse(started.out);
    await advanceToVerifying(dir, attempt.id, { passChecks: {} });
    writeCheckRegistry(dir, { unit: 0 });
    ensureCleanGitCommit(dir);
    await idefactory(dir, [
      'attempt', 'transition', attempt.id, 'awaiting-review',
      '--evidence', '{}',
    ]);
    await idefactory(dir, [
      'attempt', 'transition', attempt.id, 'accepted',
      '--evidence', JSON.stringify({ reviewerId: 'reviewer-1', verdict: 'ACCEPT' }),
    ]);
    const done = await idefactory(dir, ['complete', 'demo', '1.1', '--attempt', attempt.id]);
    assert.notEqual(done.code, 0);
    assert.match(done.err, /Missing passing check|attestation|issuer/i);
    assert.equal(getWorkItem(dir, 'demo', '1.1').status, 'in_progress');
    assert.notEqual(getAttempt(dir, attempt.id).state, 'finalized');
  } finally {
    cleanup(dir);
  }
});

test('complete finalizes work item and OpenSpec checkbox', async () => {
  const dir = tempProject();
  try {
    await seedChange(dir);
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
    const attempt = JSON.parse(started.out);
    await acceptAttempt(dir, attempt.id);
    const done = await idefactory(dir, ['complete', 'demo', '1.1', '--attempt', attempt.id]);
    assert.equal(done.code, 0, done.err);
    assert.equal(getWorkItem(dir, 'demo', '1.1').status, 'done');
    assert.equal(getAttempt(dir, attempt.id).state, 'finalized');
    const tasks = fs.readFileSync(path.join(dir, 'openspec/changes/demo/tasks.md'), 'utf8');
    assert.match(tasks, /- \[x\] 1\.1 Add parser/);
    const unit = getAttempt(dir, attempt.id).evidence.verification
      .find((entry) => entry.kind === 'unit');
    assert.ok(unit, 'finalize must keep a stored unit verification record');
    assert.equal(unit.issuer, 'cli');
    assert.equal(unit.sourceRevision, git(dir, ['rev-parse', 'HEAD']));
  } finally {
    cleanup(dir);
  }
});

test('HALT blocks run, attempt mutations, and complete without agent requests', async () => {
  const dir = tempProject();
  try {
    await seedChange(dir);
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
    assert.equal(started.code, 0, started.err);
    const attempt = JSON.parse(started.out);
    await acceptAttempt(dir, attempt.id);

    fs.writeFileSync(path.join(dir, 'HALT'), 'stop\n');

    const haltedRun = await idefactory(dir, ['run', '--change', 'demo']);
    assert.notEqual(haltedRun.code, 0);
    assert.match(haltedRun.err, /HALT/);
    assert.doesNotMatch(haltedRun.out, /Orchestration request/);
    assert.doesNotMatch(haltedRun.out, /"action": "agent-step"/);

    const haltedTransition = await idefactory(dir, [
      'attempt', 'transition', attempt.id, 'finalized',
      '--evidence', JSON.stringify({ completed: true }),
    ]);
    assert.notEqual(haltedTransition.code, 0);
    assert.match(haltedTransition.err, /HALT/);

    const haltedComplete = await idefactory(dir, ['complete', 'demo', '1.1', '--attempt', attempt.id]);
    assert.notEqual(haltedComplete.code, 0);
    assert.match(haltedComplete.err, /HALT/);
    assert.equal(getWorkItem(dir, 'demo', '1.1').status, 'in_progress');
    assert.equal(getAttempt(dir, attempt.id).state, 'accepted');
  } finally {
    cleanup(dir);
  }
});

test('lockout blocks complete', async () => {
  const dir = tempProject();
  try {
    await seedChange(dir);
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
    const attempt = JSON.parse(started.out);
    await acceptAttempt(dir, attempt.id);
    assert.equal((await idefactory(dir, [
      'lockout', '--agent', 'engineer-1', '--reviewer', 'reviewer', '--reason', 'style',
    ])).code, 0);
    const done = await idefactory(dir, ['complete', 'demo', '1.1', '--attempt', attempt.id]);
    assert.notEqual(done.code, 0);
    assert.match(done.err, /lockout/i);
  } finally {
    cleanup(dir);
  }
});

test('complete refuses forged passed:true without verification-command attestation', async () => {
  const dir = tempProject();
  try {
    await seedChange(dir);
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
    const attempt = JSON.parse(started.out);
    await acceptAttempt(dir, attempt.id, { passChecks: {} });
    writeCheckRegistry(dir, { unit: 0 });
    ensureCleanGitCommit(dir);
    writeAttemptEvidence(dir, attempt.id, {
      verification: [{ kind: 'unit', command: 'npm test', passed: true }],
    });
    await assertCompleteLeavesUnfinished(dir, attempt.id, /attestation|issuer|exitCode|verification/i);
  } finally {
    cleanup(dir);
  }
});

test('complete refuses unknown check kind', async () => {
  const dir = tempProject();
  try {
    await seedChange(dir, [
      '- [ ] 1.1 Add parser',
      '  factory:',
      '    kind: general',
      '    checks: [unit, totally-unknown-check]',
      '    verificationProfile: frontend-low',
      '    roles: [engineer, reviewer, scribe]',
      '',
    ].join('\n'));
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
    const attempt = JSON.parse(started.out);
    await acceptAttempt(dir, attempt.id, { passChecks: { unit: 0 } });
    const stored = getAttempt(dir, attempt.id);
    const unit = stored.evidence.verification.find((entry) => entry.kind === 'unit');
    assert.ok(unit);
    // Old boolean gate would accept a forged pass for the unknown kind.
    writeAttemptEvidence(dir, attempt.id, {
      verification: [
        unit,
        { kind: 'totally-unknown-check', command: 'true', passed: true },
      ],
    });
    await assertCompleteLeavesUnfinished(dir, attempt.id, /unknown|unmapped|totally-unknown-check/i);
  } finally {
    cleanup(dir);
  }
});

test('complete refuses kind with no argv mapping', async () => {
  const dir = tempProject();
  try {
    await seedChange(dir, [
      '- [ ] 1.1 Add parser',
      '  factory:',
      '    kind: general',
      '    checks: [unit, bare-kind]',
      '    verificationProfile: frontend-low',
      '    roles: [engineer, reviewer, scribe]',
      '',
    ].join('\n'));
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
    const attempt = JSON.parse(started.out);
    await acceptAttempt(dir, attempt.id, { passChecks: { unit: 0 } });
    const unitArgv = [process.execPath, '-e', 'process.exit(0)'];
    const registry = {
      schemaVersion: 1,
      checks: {
        unit: {
          argv: unitArgv,
          cwdPolicy: 'project',
          timeoutMs: 30_000,
          artifacts: [],
        },
        'bare-kind': {
          cwdPolicy: 'project',
          timeoutMs: 30_000,
          artifacts: [],
        },
      },
    };
    fs.writeFileSync(
      path.join(dir, '.factory/checks.json'),
      `${JSON.stringify(registry, null, 2)}\n`,
    );
    const head = ensureCleanGitCommit(dir);
    const stored = getAttempt(dir, attempt.id);
    const unit = stored.evidence.verification.find((entry) => entry.kind === 'unit');
    assert.ok(unit);
    writeAttemptEvidence(dir, attempt.id, {
      verification: [
        { ...unit, sourceRevision: head, worktreeClean: true },
        {
          schemaVersion: 1,
          kind: 'bare-kind',
          issuer: 'cli',
          runner: { name: 'idefactory', version: '0.0.0' },
          argv: ['true'],
          commandDigest: commandDigest(['true']),
          exitCode: 0,
          timedOut: false,
          attemptId: attempt.id,
          sourceRevision: head,
          worktreeClean: true,
          passed: true,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          logDigest: 'sha256:' + '0'.repeat(64),
          artifactDigests: [],
        },
      ],
    });
    await assertCompleteLeavesUnfinished(dir, attempt.id, /argv|mapping|bare-kind/i);
  } finally {
    cleanup(dir);
  }
});

test('complete refuses non-zero exit code attestation', async () => {
  const dir = tempProject();
  try {
    await seedChange(dir);
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
    const attempt = JSON.parse(started.out);
    await acceptAttempt(dir, attempt.id, { passChecks: {} });
    writeCheckRegistry(dir, { unit: 0 });
    const head = ensureCleanGitCommit(dir);
    const argv = [process.execPath, '-e', 'process.exit(0)'];
    writeAttemptEvidence(dir, attempt.id, {
      verification: [{
        schemaVersion: 1,
        kind: 'unit',
        issuer: 'cli',
        runner: { name: 'idefactory', version: '0.0.0' },
        argv,
        commandDigest: commandDigest(argv),
        exitCode: 1,
        timedOut: false,
        attemptId: attempt.id,
        sourceRevision: head,
        worktreeClean: true,
        passed: true,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        logDigest: 'sha256:' + '0'.repeat(64),
        artifactDigests: [],
      }],
    });
    await assertCompleteLeavesUnfinished(dir, attempt.id, /exit|pass|unit/i);
  } finally {
    cleanup(dir);
  }
});

test('complete refuses missing exit code on attestation', async () => {
  const dir = tempProject();
  try {
    await seedChange(dir);
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
    const attempt = JSON.parse(started.out);
    await acceptAttempt(dir, attempt.id, { passChecks: {} });
    writeCheckRegistry(dir, { unit: 0 });
    const head = ensureCleanGitCommit(dir);
    const argv = [process.execPath, '-e', 'process.exit(0)'];
    writeAttemptEvidence(dir, attempt.id, {
      verification: [{
        schemaVersion: 1,
        kind: 'unit',
        issuer: 'cli',
        runner: { name: 'idefactory', version: '0.0.0' },
        argv,
        commandDigest: commandDigest(argv),
        timedOut: false,
        attemptId: attempt.id,
        sourceRevision: head,
        worktreeClean: true,
        passed: true,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        logDigest: 'sha256:' + '0'.repeat(64),
        artifactDigests: [],
      }],
    });
    await assertCompleteLeavesUnfinished(dir, attempt.id, /exitCode|exit code/i);
  } finally {
    cleanup(dir);
  }
});

test('complete refuses command-digest mismatch against current registry', async () => {
  const dir = tempProject();
  try {
    await seedChange(dir);
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
    const attempt = JSON.parse(started.out);
    await acceptAttempt(dir, attempt.id, { passChecks: { unit: 0 } });
    writeCheckRegistry(dir, { unit: 0 });
    // Rewrite argv so the stored digest no longer matches the registry.
    fs.writeFileSync(
      path.join(dir, '.factory/checks.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        checks: {
          unit: {
            argv: [process.execPath, '-e', 'process.exit(0); /* changed */'],
            cwdPolicy: 'project',
            timeoutMs: 30_000,
            artifacts: [],
          },
        },
      }, null, 2)}\n`,
    );
    ensureCleanGitCommit(dir);
    // Re-bind stored attestation to the new HEAD but keep the old commandDigest.
    const head = git(dir, ['rev-parse', 'HEAD']);
    const stored = getAttempt(dir, attempt.id);
    const record = stored.evidence.verification.find((entry) => entry.kind === 'unit');
    assert.ok(record);
    writeAttemptEvidence(dir, attempt.id, {
      verification: [{ ...record, sourceRevision: head, worktreeClean: true, passed: true }],
    });
    await assertCompleteLeavesUnfinished(dir, attempt.id, /digest|commandDigest|registry/i);
  } finally {
    cleanup(dir);
  }
});

test('complete refuses source revision other than current clean HEAD', async () => {
  const dir = tempProject();
  try {
    await seedChange(dir);
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
    const attempt = JSON.parse(started.out);
    await acceptAttempt(dir, attempt.id, { passChecks: { unit: 0 } });
    fs.writeFileSync(path.join(dir, 'stale-marker.txt'), 'after verify\n');
    ensureCleanGitCommit(dir);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const stored = getAttempt(dir, attempt.id);
    const record = stored.evidence.verification.find((entry) => entry.kind === 'unit');
    assert.ok(record);
    assert.notEqual(record.sourceRevision, head);
    await assertCompleteLeavesUnfinished(dir, attempt.id, /sourceRevision|revision|HEAD/i);
  } finally {
    cleanup(dir);
  }
});

test('run emits needs-complete for finalized attempt with matching unfinished journal', async () => {
  const dir = tempProject();
  try {
    await seedChange(dir);
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
    const attempt = JSON.parse(started.out);
    await acceptAttempt(dir, attempt.id, { passChecks: { unit: 0 } });

    const sourceRevision = ensureCleanGitCommit(dir);
    const plan = buildFinalizationPlan(dir, {
      change: 'demo',
      taskId: '1.1',
      attemptId: attempt.id,
      sourceRevision,
      completionDate: '2026-10-21',
      finalizedAt: '2026-10-21T22:00:00.000Z',
    });
    createFinalizationJournal(dir, plan.journal, {
      change: 'demo',
      taskId: '1.1',
      attemptId: attempt.id,
      sourceRevision,
    });
    // Crash after attempt finalization: attempt is finalized, journal unfinished, item not done.
    writeText(path.join(dir, plan.targets[3].path), plan.targets[3].afterBytes);
    assert.equal(getAttempt(dir, attempt.id).state, 'finalized');
    assert.notEqual(getWorkItem(dir, 'demo', '1.1').status, 'done');

    const result = await idefactory(dir, ['run', '--change', 'demo', '--new-run']);
    assert.equal(result.code, 2, result.err + result.out);
    assert.match(result.out, /# Orchestration request/);
    assert.match(result.out, /Action: complete/);
    const request = parseOrchestrationJson(result.out);
    assert.equal(request.action, 'complete');
    assert.equal(request.role, 'scribe');
    assert.equal(request.attemptId, attempt.id);
    assert.equal(request.taskId, '1.1');
    assert.equal(getWorkItem(dir, 'demo', '1.1').status, 'in_progress');
    assert.equal(getAttempt(dir, attempt.id).state, 'finalized');
  } finally {
    cleanup(dir);
  }
});

test('quick route implements as engineer and verifies as reviewer unless security is explicit', async () => {
  const dir = tempProject();
  try {
    await seedChange(dir, [
      'factory-route: quick',
      '',
      '- [ ] 1.1 Fix the auth parser',
      '  factory:',
      '    kind: general',
      '    checks: [unit]',
      '    verificationProfile: frontend-low',
      '    roles: [architect, reviewer, scribe]',
      '',
    ].join('\n'));
    const stored = getWorkItem(dir, 'demo', '1.1');
    stored.factory.roles = ['architect', 'reviewer', 'scribe'];
    fs.writeFileSync(itemPath(dir, 'demo', '1.1'), `${JSON.stringify(stored, null, 2)}\n`);
    const first = await idefactory(dir, ['run', '--change', 'demo', '--max-tasks', '1']);
    assert.equal(first.code, 2, first.err + first.out);
    assert.match(first.out, /^Role: engineer$/m);

    const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
    assert.equal(started.code, 0, started.err);
    const attempt = JSON.parse(started.out);
    await advanceToVerifying(dir, attempt.id, { passChecks: {} });
    const review = await idefactory(dir, ['run', '--change', 'demo', '--max-tasks', '1']);
    assert.equal(review.code, 2, review.err + review.out);
    assert.match(review.out, /^Role: reviewer$/m);
  } finally {
    cleanup(dir);
  }

  const sensitive = tempProject();
  try {
    await seedChange(sensitive, [
      'factory-route: quick',
      '',
      '- [ ] 1.1 Fix the parser',
      '  factory:',
      '    kind: general',
      '    checks: [unit]',
      '    securityProfile: security-sensitive',
      '    verificationProfile: frontend-low',
      '',
    ].join('\n'));
    const started = await idefactory(sensitive, ['attempt', 'start', 'demo', '1.1']);
    assert.equal(started.code, 0, started.err);
    const attempt = JSON.parse(started.out);
    await advanceToVerifying(sensitive, attempt.id, { passChecks: {} });
    const review = await idefactory(sensitive, ['run', '--change', 'demo', '--max-tasks', '1']);
    assert.equal(review.code, 2, review.err + review.out);
    assert.match(review.out, /^Role: security-reviewer$/m);
  } finally {
    cleanup(sensitive);
  }
});
