import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { getAttempt } from '../src/lib/attempt.mjs';
import { getWorkItem } from '../src/lib/work.mjs';
import { cleanup, idefactory, repoRoot, tempProject } from './helpers.mjs';

const IMPLEMENTER = 'bc-engineer-1';
const SECURITY_REVIEWER = 'bc-security-reviewer-1';
const fakeForge = path.join(repoRoot, 'support/fake-forge.mjs');
const FORBIDDEN_ARGV = [
  /\bmerge\b/i,
  /\brulesets\b/i,
  /branches\/.+\/protection/i,
  /api\.github\.com/i,
  /\bgh\s+api\b/i,
];

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

function setPolicyVersion(dir, version) {
  const configPath = path.join(dir, '.factory/config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.governance.policyVersion = version;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
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

async function seedSecurityStageChange(dir, {
  taskId = '1.1',
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

async function seedSecurityCheckingWithPassingEvidence(dir, taskId = '1.1') {
  await seedSecurityStageChange(dir, {
    taskId,
    securityProfile: 'security-sensitive',
    verificationProfile: 'frontend-low',
    checks: ['unit'],
  });
  const item = getWorkItem(dir, 'demo', taskId);
  assert.equal(item.factory?.securityProfile, 'security-sensitive');
  const started = await idefactory(dir, ['attempt', 'start', 'demo', taskId]);
  assert.equal(started.code, 0, started.err + started.out);
  const attemptId = JSON.parse(started.out).id;
  await advanceToSecurityChecking(dir, attemptId);
  const afterVerify = await recordPassingSecurityCheck(dir, attemptId, 'threat-review');
  const security = afterVerify.evidence.security || [];
  assert.equal(security.length, 1);
  assert.equal(security[0].kind, 'threat-review');
  assert.equal(security[0].issuer, 'cli');
  assert.equal(security[0].passed, true);
  assert.equal(getAttempt(dir, attemptId).implementerId, IMPLEMENTER);
  return attemptId;
}

test('security-stage handoff without ACCEPT verdict or security reviewer stays in security-checking', async () => {
  const dir = tempProject();
  try {
    const attemptId = await seedSecurityCheckingWithPassingEvidence(dir, '1.1');

    const missingVerdict = await idefactory(dir, [
      'attempt', 'transition', attemptId, 'awaiting-review',
      '--evidence', JSON.stringify({}),
    ]);
    assert.notEqual(missingVerdict.code, 0, missingVerdict.err + missingVerdict.out);
    assert.equal(getAttempt(dir, attemptId).state, 'security-checking');

    const missingReviewer = await idefactory(dir, [
      'attempt', 'transition', attemptId, 'awaiting-review',
      '--evidence', JSON.stringify({ verdict: 'ACCEPT' }),
    ]);
    assert.notEqual(missingReviewer.code, 0, missingReviewer.err + missingReviewer.out);
    assert.equal(getAttempt(dir, attemptId).state, 'security-checking');
  } finally {
    cleanup(dir);
  }
});

test('ACCEPT verdict with distinct securityReviewerId advances security-stage work to awaiting-review', async () => {
  const dir = tempProject();
  try {
    const attemptId = await seedSecurityCheckingWithPassingEvidence(dir, '1.1');

    const ok = await idefactory(dir, [
      'attempt', 'transition', attemptId, 'awaiting-review',
      '--evidence', JSON.stringify({
        verdict: 'ACCEPT',
        securityReviewerId: SECURITY_REVIEWER,
      }),
    ]);
    assert.equal(ok.code, 0, ok.err + ok.out);
    assert.equal(getAttempt(dir, attemptId).state, 'awaiting-review');
    assert.notEqual(SECURITY_REVIEWER, IMPLEMENTER);
  } finally {
    cleanup(dir);
  }
});

test('security reviewer cannot match implementer for ACCEPT or REJECT', async () => {
  for (const verdict of ['ACCEPT', 'REJECT']) {
    const dir = tempProject();
    try {
      const attemptId = await seedSecurityCheckingWithPassingEvidence(dir, '1.2');

      const rejected = await idefactory(dir, [
        'attempt', 'transition', attemptId, verdict === 'ACCEPT' ? 'awaiting-review' : 'rejected',
        '--evidence', JSON.stringify({
          verdict,
          securityReviewerId: IMPLEMENTER,
        }),
      ]);
      assert.notEqual(rejected.code, 0, rejected.err + rejected.out);
      assert.equal(getAttempt(dir, attemptId).state, 'security-checking');
    } finally {
      cleanup(dir);
    }
  }
});

test('distinct security reviewer REJECT transitions directly to rejected', async () => {
  const dir = tempProject();
  try {
    const attemptId = await seedSecurityCheckingWithPassingEvidence(dir, '1.2');

    const rejected = await idefactory(dir, [
      'attempt', 'transition', attemptId, 'rejected',
      '--evidence', JSON.stringify({
        verdict: 'REJECT',
        securityReviewerId: SECURITY_REVIEWER,
      }),
    ]);
    assert.equal(rejected.code, 0, rejected.err + rejected.out);

    const attempt = getAttempt(dir, attemptId);
    assert.equal(attempt.state, 'rejected');
    assert.notEqual(attempt.evidence.review?.role, 'reviewer');
  } finally {
    cleanup(dir);
  }
});

function readArgvLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function commentBodies(argvLists) {
  return argvLists
    .filter((argv) => argv[0] === 'pr' && argv[1] === 'comment')
    .map((argv) => {
      const index = argv.indexOf('--body');
      return index >= 0 ? argv[index + 1] : '';
    });
}

function assertSafeForgeArgv(argvLists) {
  assert.ok(argvLists.length > 0, 'stub forge must record at least one argv');
  for (const argv of argvLists) {
    assert.ok(Array.isArray(argv), 'each stub log entry must be an argv array');
    const joined = argv.join(' ');
    for (const pattern of FORBIDDEN_ARGV) {
      assert.doesNotMatch(
        joined,
        pattern,
        `stub argv must not merge or call forge admin API: ${joined}`,
      );
    }
  }
}

test('stored security reviewer identity is kept and named on the pull request comment', async () => {
  const dir = tempProject();
  const logPath = path.join(dir, 'forge-argv.log');
  const dbPath = path.join(dir, 'forge-db.json');
  const forgeEnv = {
    IDEFACTORY_FORGE: fakeForge,
    IDEFACTORY_FORGE_LOG: logPath,
    IDEFACTORY_FORGE_DB: dbPath,
  };
  try {
    await seedSecurityStageChange(dir, {
      taskId: '1.3',
      securityProfile: 'security-sensitive',
      verificationProfile: 'frontend-low',
      checks: ['unit'],
    });
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.3']);
    assert.equal(started.code, 0, started.err + started.out);
    const attemptId = JSON.parse(started.out).id;
    await advanceToSecurityChecking(dir, attemptId);

    // Pull-request records are not factory run-state. Open and commit one
    // before the threat-review pass so that pass stays bound to a clean HEAD.
    const opened = await idefactory(dir, ['pr', 'open', 'demo'], forgeEnv);
    assert.equal(opened.code, 0, opened.err + opened.out);
    assert.equal(
      fs.existsSync(path.join(dir, '.factory', 'pull-requests', 'demo.json')),
      true,
    );
    ensureCleanGitCommit(dir);

    const afterVerify = await recordPassingSecurityCheck(dir, attemptId, 'threat-review');
    const security = afterVerify.evidence.security || [];
    assert.equal(security.length, 1);
    assert.equal(security[0].kind, 'threat-review');
    assert.equal(security[0].issuer, 'cli');
    assert.equal(security[0].passed, true);
    assert.equal(security[0].worktreeClean, true);

    const handedOff = await idefactory(dir, [
      'attempt', 'transition', attemptId, 'awaiting-review',
      '--evidence', JSON.stringify({
        verdict: 'ACCEPT',
        securityReviewerId: SECURITY_REVIEWER,
      }),
    ], forgeEnv);
    assert.equal(handedOff.code, 0, handedOff.err + handedOff.out);

    const stored = getAttempt(dir, attemptId);
    assert.equal(stored.state, 'awaiting-review');
    assert.equal(stored.evidence.securityReview?.verdict, 'ACCEPT');
    assert.equal(stored.evidence.securityReview?.role, 'security-reviewer');
    const bodies = commentBodies(readArgvLog(logPath));
    assert.equal(bodies.length, 1);
    assertSafeForgeArgv(readArgvLog(logPath));
    assert.equal(stored.evidence.securityReview?.reviewerId, SECURITY_REVIEWER);
    assert.match(bodies[0], new RegExp(`^Reviewer: ${SECURITY_REVIEWER}$`, 'm'));
  } finally {
    cleanup(dir);
  }
});
