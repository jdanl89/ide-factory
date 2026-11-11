import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { getAttempt } from '../src/lib/attempt.mjs';
import { writeText } from '../src/lib/layout.mjs';
import { getWorkItem } from '../src/lib/work.mjs';
import { cleanup, idefactory, repoRoot, tempProject } from './helpers.mjs';

const HOUR_MS = 60 * 60 * 1000;

const FACTORY_GOVERNANCE_SKILL_COPIES = [
  '.cursor/skills/factory-governance/SKILL.md',
  '.github/skills/factory-governance/SKILL.md',
  '.agents/skills/factory-governance/SKILL.md',
  '.claude/skills/factory-governance/SKILL.md',
  'templates/skills/factory-governance/SKILL.md',
];

function sha256Digest(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function mapUnit(dir) {
  const registryPath = path.join(dir, '.factory/checks.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  registry.checks.unit = {
    argv: ['node', '--test'],
    cwdPolicy: 'project',
    timeoutMs: 120000,
    artifacts: [],
  };
  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

function extractPrintedLockoutId(out) {
  const match = out.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)
    || out.match(/lockout\s+id[:\s]+([A-Za-z0-9._-]+)/i)
    || out.match(/\bid[:\s]+([A-Za-z0-9._-]+)/i);
  assert.ok(match, `stdout must print a lockout id; got: ${out}`);
  return match[1];
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

async function seedDemoChange(dir) {
  assert.equal((await idefactory(dir, ['init'])).code, 0);
  setPolicyVersion(dir, 1);
  fs.mkdirSync(path.join(dir, 'openspec/changes/demo'), { recursive: true });
  writeText(
    path.join(dir, 'openspec/changes/demo/tasks.md'),
    [
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

async function acceptDemoAttempt(dir, attemptId) {
  writeCheckRegistry(dir, { unit: 1 });
  assert.equal((await idefactory(dir, [
    'verify', 'run', attemptId, '--check', 'unit', '--red',
  ])).code, 0);
  assert.equal((await idefactory(dir, [
    'attempt', 'transition', attemptId, 'implementing',
    '--evidence', JSON.stringify({ implementerId: 'engineer-1' }),
  ])).code, 0);
  assert.equal((await idefactory(dir, [
    'attempt', 'transition', attemptId, 'red-confirmed',
    '--evidence', JSON.stringify({}),
  ])).code, 0);
  writeCheckRegistry(dir, { unit: 0 });
  ensureFactoryGitignore(dir);
  ensureCleanGitCommit(dir);
  assert.equal((await idefactory(dir, [
    'verify', 'run', attemptId, '--check', 'unit',
  ])).code, 0);
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

function scopedApproveArgs(id, note) {
  return [
    'approve', id, '--note', note,
    '--change', 'demo',
    '--task', '1.1',
    '--action', 'accept',
    '--approver', 'bc-approver-9',
    '--expiry', new Date(Date.now() + 12 * HOUR_MS).toISOString(),
  ];
}

test('doctor requires .factory/governance.md and does not require GOLDEN_RULES.md', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    mapUnit(dir);
    assert.equal(fs.existsSync(path.join(dir, 'GOLDEN_RULES.md')), false);
    assert.equal((await idefactory(dir, ['doctor'])).code, 0);
    fs.unlinkSync(path.join(dir, '.factory/governance.md'));
    const missing = await idefactory(dir, ['doctor']);
    assert.notEqual(missing.code, 0);
    assert.match(`${missing.out}${missing.err}`, /governance\.md/);
    assert.doesNotMatch(`${missing.out}${missing.err}`, /GOLDEN_RULES/);
    fs.writeFileSync(path.join(dir, 'GOLDEN_RULES.md'), 'legacy\n');
    const withLegacy = await idefactory(dir, ['doctor']);
    assert.notEqual(withLegacy.code, 0);
    assert.match(`${withLegacy.out}${withLegacy.err}`, /governance\.md/);
    assert.doesNotMatch(`${withLegacy.out}${withLegacy.err}`, /GOLDEN_RULES/);
  } finally {
    cleanup(dir);
  }
});

test('approve and reject append, and lockout writes a note', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const config = JSON.parse(fs.readFileSync(path.join(dir, '.factory/config.json'), 'utf8'));
    config.governance.policyVersion = 1;
    fs.writeFileSync(path.join(dir, '.factory/config.json'), JSON.stringify(config, null, 2));
    ensureCleanGitCommit(dir);
    const first = await idefactory(dir, scopedApproveArgs('spend-ok', 'allowed for test'));
    assert.equal(first.code, 0, first.err);
    ensureCleanGitCommit(dir);
    const second = await idefactory(dir, scopedApproveArgs('second-ok', 'also allowed'));
    assert.equal(second.code, 0, second.err);
    const decisions = fs.readFileSync(path.join(dir, '.factory/decisions.md'), 'utf8');
    assert.match(decisions, /spend-ok/);
    assert.match(decisions, /second-ok/);
    const approvals = fs.readdirSync(path.join(dir, '.factory/approvals')).filter((name) => name.endsWith('.json'));
    const bodies = approvals.map((name) => fs.readFileSync(path.join(dir, '.factory/approvals', name), 'utf8')).join('\n');
    assert.match(bodies, /allowed for test/);
    const rejected = await idefactory(dir, ['reject', 'nope', '--note', 'not this']);
    assert.equal(rejected.code, 0, rejected.err);
    const after = fs.readFileSync(path.join(dir, '.factory/decisions.md'), 'utf8');
    assert.match(after, /rejected/);
    assert.match(after, /nope/);
    assert.match(after, /spend-ok/);
    const locked = await idefactory(dir, ['lockout', '--agent', 'engineer', '--reviewer', 'reviewer', '--reason', 'tests failed']);
    assert.equal(locked.code, 0, locked.err);
    const lockoutId = extractPrintedLockoutId(locked.out);
    const createdPath = path.join(dir, '.factory/orchestration/lockouts', lockoutId, 'created.json');
    assert.equal(fs.existsSync(createdPath), true, 'lockout alias must write created.json');
    const created = JSON.parse(fs.readFileSync(createdPath, 'utf8'));
    assert.equal(created.schemaVersion, 1);
    assert.equal(created.agent, 'engineer');
    assert.match(created.reason, /tests failed/);
    assert.equal(fs.existsSync(path.join(dir, 'app.js')), false);
  } finally {
    cleanup(dir);
  }
});

test('lockout create writes immutable schema version 1 created.json under a printed id', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const created = await idefactory(dir, [
      'lockout', 'create',
      '--agent', 'engineer-a',
      '--reviewer', 'reviewer-b',
      '--reason', 'acceptance failed',
    ]);
    assert.equal(created.code, 0, created.err + created.out);
    const lockoutId = extractPrintedLockoutId(created.out);
    const createdPath = path.join(dir, '.factory/orchestration/lockouts', lockoutId, 'created.json');
    assert.equal(fs.existsSync(createdPath), true);
    const record = JSON.parse(fs.readFileSync(createdPath, 'utf8'));
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.id, lockoutId);
    assert.equal(record.agent, 'engineer-a');
    assert.equal(record.reviewer, 'reviewer-b');
    assert.equal(record.reason, 'acceptance failed');
    assert.equal(typeof record.createdAt, 'string');
    assert.match(record.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    const before = fs.readFileSync(createdPath, 'utf8');
    const again = await idefactory(dir, [
      'lockout', 'create',
      '--agent', 'engineer-c',
      '--reviewer', 'reviewer-d',
      '--reason', 'other',
    ]);
    assert.equal(again.code, 0, again.err + again.out);
    assert.equal(fs.readFileSync(createdPath, 'utf8'), before, 'prior created.json must stay immutable');
  } finally {
    cleanup(dir);
  }
});

test('active versioned lockout blocks complete until resolved by distinct resolver', async () => {
  const dir = tempProject();
  try {
    await seedDemoChange(dir);
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
    assert.equal(started.code, 0, started.err + started.out);
    const attemptId = JSON.parse(started.out).id;
    await acceptDemoAttempt(dir, attemptId);

    const locked = await idefactory(dir, [
      'lockout', 'create',
      '--agent', 'engineer-1',
      '--reviewer', 'reviewer-9',
      '--reason', 'tests failed',
    ]);
    assert.equal(locked.code, 0, locked.err + locked.out);
    const lockoutId = extractPrintedLockoutId(locked.out);

    const blocked = await idefactory(dir, ['complete', 'demo', '1.1', '--attempt', attemptId]);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.err, /lockout/i);
    assert.notEqual(getWorkItem(dir, 'demo', '1.1').status, 'done');

    const sameAgent = await idefactory(dir, [
      'lockout', 'resolve', lockoutId,
      '--resolver', 'engineer-1',
      '--reason', 'fixed',
    ]);
    assert.notEqual(sameAgent.code, 0, 'resolver must differ from locked agent');

    const missingReason = await idefactory(dir, [
      'lockout', 'resolve', lockoutId,
      '--resolver', 'lead-1',
    ]);
    assert.notEqual(missingReason.code, 0, 'resolve requires --reason');

    const resolved = await idefactory(dir, [
      'lockout', 'resolve', lockoutId,
      '--resolver', 'lead-1',
      '--reason', 'fixed and retested',
    ]);
    assert.equal(resolved.code, 0, resolved.err + resolved.out);
    const resolvedPath = path.join(dir, '.factory/orchestration/lockouts', lockoutId, 'resolved.json');
    assert.equal(fs.existsSync(resolvedPath), true);
    const resolution = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    assert.equal(resolution.schemaVersion, 1);
    assert.equal(resolution.resolver, 'lead-1');
    assert.equal(resolution.reason, 'fixed and retested');
    assert.equal(typeof resolution.resolvedAt, 'string');
    const createdPath = path.join(dir, '.factory/orchestration/lockouts', lockoutId, 'created.json');
    assert.equal(fs.existsSync(createdPath), true, 'creation event must remain');

    const done = await idefactory(dir, ['complete', 'demo', '1.1', '--attempt', attemptId]);
    assert.equal(done.code, 0, done.err + done.out);
    assert.equal(getWorkItem(dir, 'demo', '1.1').status, 'done');
    assert.equal(getAttempt(dir, attemptId).state, 'finalized');
  } finally {
    cleanup(dir);
  }
});

test('lockout resolve is idempotent for exact repeats and rejects conflicts', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    setPolicyVersion(dir, 1);
    const locked = await idefactory(dir, [
      'lockout', '--agent', 'engineer-x', '--reviewer', 'reviewer-y', '--reason', 'reject',
    ]);
    assert.equal(locked.code, 0, locked.err + locked.out);
    const lockoutId = extractPrintedLockoutId(locked.out);
    const first = await idefactory(dir, [
      'lockout', 'resolve', lockoutId,
      '--resolver', 'lead-2',
      '--reason', 'ok to continue',
    ]);
    assert.equal(first.code, 0, first.err + first.out);
    const resolvedPath = path.join(dir, '.factory/orchestration/lockouts', lockoutId, 'resolved.json');
    const before = fs.readFileSync(resolvedPath, 'utf8');
    const createdBefore = fs.readFileSync(
      path.join(dir, '.factory/orchestration/lockouts', lockoutId, 'created.json'),
      'utf8',
    );

    const repeat = await idefactory(dir, [
      'lockout', 'resolve', lockoutId,
      '--resolver', 'lead-2',
      '--reason', 'ok to continue',
    ]);
    assert.equal(repeat.code, 0, repeat.err + repeat.out);
    assert.equal(fs.readFileSync(resolvedPath, 'utf8'), before, 'exact repeat must not rewrite resolved.json');
    assert.equal(
      fs.readFileSync(path.join(dir, '.factory/orchestration/lockouts', lockoutId, 'created.json'), 'utf8'),
      createdBefore,
    );

    const conflictResolver = await idefactory(dir, [
      'lockout', 'resolve', lockoutId,
      '--resolver', 'lead-3',
      '--reason', 'ok to continue',
    ]);
    assert.notEqual(conflictResolver.code, 0);
    assert.equal(fs.readFileSync(resolvedPath, 'utf8'), before);

    const conflictReason = await idefactory(dir, [
      'lockout', 'resolve', lockoutId,
      '--resolver', 'lead-2',
      '--reason', 'different reason',
    ]);
    assert.notEqual(conflictReason.code, 0);
    assert.equal(fs.readFileSync(resolvedPath, 'utf8'), before);
    assert.equal(
      fs.readFileSync(path.join(dir, '.factory/orchestration/lockouts', lockoutId, 'created.json'), 'utf8'),
      createdBefore,
    );
  } finally {
    cleanup(dir);
  }
});

test('legacy markdown lockout resolves by basename and digest without mutating the note', async () => {
  const dir = tempProject();
  try {
    await seedDemoChange(dir);
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
    assert.equal(started.code, 0, started.err + started.out);
    const attemptId = JSON.parse(started.out).id;
    await acceptDemoAttempt(dir, attemptId);

    const basename = '2026-10-21T12-00-00-000Z-lockout.md';
    const legacyRel = path.join('.factory', 'orchestration', basename);
    const legacyBody = '# Lockout\n\nAgent: engineer-legacy\nReviewer: reviewer\nReason: old note\n';
    writeText(path.join(dir, legacyRel), legacyBody);
    const legacyDigest = sha256Digest(legacyBody.endsWith('\n') ? legacyBody : `${legacyBody}\n`);

    const blocked = await idefactory(dir, ['complete', 'demo', '1.1', '--attempt', attemptId]);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.err, /lockout/i);

    const resolved = await idefactory(dir, [
      'lockout', 'resolve', basename,
      '--resolver', 'lead-legacy',
      '--reason', 'migrated to event record',
    ]);
    assert.equal(resolved.code, 0, resolved.err + resolved.out);

    const afterLegacy = fs.readFileSync(path.join(dir, legacyRel), 'utf8');
    assert.equal(afterLegacy, legacyBody.endsWith('\n') ? legacyBody : `${legacyBody}\n`);
    assert.equal(fs.existsSync(path.join(dir, legacyRel)), true);

    const eventDir = path.join(dir, '.factory/orchestration/lockouts', basename);
    const created = JSON.parse(fs.readFileSync(path.join(eventDir, 'created.json'), 'utf8'));
    assert.equal(created.schemaVersion, 1);
    assert.equal(created.legacyPath, legacyRel.replace(/\\/g, '/'));
    assert.equal(created.legacyDigest, legacyDigest);
    const resolution = JSON.parse(fs.readFileSync(path.join(eventDir, 'resolved.json'), 'utf8'));
    assert.equal(resolution.resolver, 'lead-legacy');
    assert.equal(resolution.reason, 'migrated to event record');

    const done = await idefactory(dir, ['complete', 'demo', '1.1', '--attempt', attemptId]);
    assert.equal(done.code, 0, done.err + done.out);
    assert.equal(getWorkItem(dir, 'demo', '1.1').status, 'done');
  } finally {
    cleanup(dir);
  }
});

test('shipped factory-governance skill copies document lockout resolve', () => {
  for (const rel of FACTORY_GOVERNANCE_SKILL_COPIES) {
    const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    assert.match(
      text,
      /lockout resolve/,
      `${rel} must document idefactory lockout resolve`,
    );
    assert.match(
      text,
      /--resolver/,
      `${rel} must document --resolver`,
    );
  }
});

test('complete requires every code red kind and allows a lightweight item without red', async () => {
  const missing = tempProject();
  try {
    await seedDemoChange(missing);
    const itemPath = path.join(missing, '.factory/work/items/demo--1.1.json');
    const started = await idefactory(missing, ['attempt', 'start', 'demo', '1.1']);
    const attemptId = JSON.parse(started.out).id;
    await acceptDemoAttempt(missing, attemptId);
    writeCheckRegistry(missing, { unit: 0, integration: 0 });
    const item = JSON.parse(fs.readFileSync(itemPath, 'utf8'));
    item.factory.checks = ['unit', 'integration'];
    item.factory.taskType = 'code';
    fs.writeFileSync(itemPath, JSON.stringify(item, null, 2));
    ensureCleanGitCommit(missing);
    assert.equal((await idefactory(missing, ['verify', 'run', attemptId, '--check', 'unit'])).code, 0);
    assert.equal((await idefactory(missing, ['verify', 'run', attemptId, '--check', 'integration'])).code, 0);
    const blocked = await idefactory(missing, ['complete', 'demo', '1.1', '--attempt', attemptId]);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.err, /integration/);
    assert.notEqual(getWorkItem(missing, 'demo', '1.1').status, 'done');
  } finally {
    cleanup(missing);
  }

  const light = tempProject();
  try {
    assert.equal((await idefactory(light, ['init'])).code, 0);
    setPolicyVersion(light, 1);
    fs.mkdirSync(path.join(light, 'openspec/changes/demo'), { recursive: true });
    writeText(
      path.join(light, 'openspec/changes/demo/tasks.md'),
      [
        '- [ ] 1.1 Note the docs',
        '  factory:',
        '    kind: docs',
        '    taskType: lightweight',
        '    checks: [unit]',
        '    verificationProfile: frontend-low',
        '    roles: [engineer, reviewer, scribe]',
        '',
      ].join('\n'),
    );
    assert.equal((await idefactory(light, ['sync-tasks', 'demo'])).code, 0);
    const started = await idefactory(light, ['attempt', 'start', 'demo', '1.1']);
    const attemptId = JSON.parse(started.out).id;
    assert.equal((await idefactory(light, [
      'attempt', 'transition', attemptId, 'implementing',
      '--evidence', JSON.stringify({ implementerId: 'engineer-1' }),
    ])).code, 0);
    assert.equal((await idefactory(light, ['attempt', 'transition', attemptId, 'verifying'])).code, 0);
    writeCheckRegistry(light, { unit: 0 });
    ensureFactoryGitignore(light);
    ensureCleanGitCommit(light);
    assert.equal((await idefactory(light, ['verify', 'run', attemptId, '--check', 'unit'])).code, 0);
    assert.equal((await idefactory(light, ['attempt', 'transition', attemptId, 'awaiting-review'])).code, 0);
    assert.equal((await idefactory(light, [
      'attempt', 'transition', attemptId, 'accepted',
      '--evidence', JSON.stringify({ reviewerId: 'reviewer-1', verdict: 'ACCEPT' }),
    ])).code, 0);
    const done = await idefactory(light, ['complete', 'demo', '1.1', '--attempt', attemptId]);
    assert.equal(done.code, 0, done.err + done.out);
    assert.equal(getWorkItem(light, 'demo', '1.1').status, 'done');
    assert.equal(getAttempt(light, attemptId).evidence.red, null);
  } finally {
    cleanup(light);
  }
});
