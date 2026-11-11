import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs, { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getAttempt } from '../src/lib/attempt.mjs';
import {
  commandDigest,
  validateCheckRecord,
  validateCheckRegistry,
  verifyRun,
} from '../src/lib/verification-evidence.mjs';
import { cleanup, idefactory, tempProject } from './helpers.mjs';

const PROJECT_ROOT = '/tmp/idefactory-project';
const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../package.json'),
    'utf8',
  ),
).version;

function sha256Digest(bytes) {
  const hex = createHash('sha256').update(bytes).digest('hex');
  return `sha256:${hex}`;
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

function initGitRepo(dir) {
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'idefactory-test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'init']);
  return git(dir, ['rev-parse', 'HEAD']);
}

/** Init git if needed and commit the full worktree so HEAD is clean. */
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

function assertNoPassingVerification(stored) {
  const verification = stored.evidence.verification || [];
  for (const record of verification) {
    assert.notEqual(record.passed, true);
  }
  if (stored.evidence.red) {
    assert.notEqual(stored.evidence.red.passed, true);
  }
}

function validRegistry() {
  return {
    schemaVersion: 1,
    checks: {
      unit: {
        argv: ['npm', 'test'],
        cwdPolicy: 'project',
        timeoutMs: 30_000,
        artifacts: ['coverage/lcov.info'],
      },
    },
  };
}

function registryForExit(code) {
  return {
    schemaVersion: 1,
    checks: {
      unit: {
        argv: [process.execPath, '-e', `process.exit(${code})`],
        cwdPolicy: 'project',
        timeoutMs: 30_000,
        artifacts: [],
      },
    },
  };
}

async function seedAttempt(dir, registry) {
  assert.equal((await idefactory(dir, ['init'])).code, 0);
  const checks = typeof registry === 'number'
    ? registryForExit(registry)
    : registry;
  fs.writeFileSync(
    path.join(dir, '.factory/checks.json'),
    `${JSON.stringify(checks, null, 2)}\n`,
  );
  fs.mkdirSync(path.join(dir, 'openspec/changes/demo'), { recursive: true });
  fs.writeFileSync(
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
  const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
  assert.equal(started.code, 0, started.err);
  return JSON.parse(started.out);
}

function registryWithScript(script, artifacts = []) {
  return {
    schemaVersion: 1,
    checks: {
      unit: {
        argv: [process.execPath, '-e', script],
        cwdPolicy: 'project',
        timeoutMs: 30_000,
        artifacts,
      },
    },
  };
}

test('schema-valid registry accepts argv, project cwd policy, timeout, and artifacts', () => {
  const registry = validRegistry();
  const accepted = validateCheckRegistry(registry, { projectRoot: PROJECT_ROOT });
  assert.equal(accepted.schemaVersion, 1);
  const unit = accepted.checks.unit;
  assert.deepEqual(unit.argv, ['npm', 'test']);
  assert.equal(unit.cwdPolicy, 'project');
  assert.equal(unit.timeoutMs, 30_000);
  assert.deepEqual(unit.artifacts, ['coverage/lcov.info']);
  assert.equal(unit.commandDigest, commandDigest(['npm', 'test']));
  assert.match(unit.commandDigest, /^sha256:[0-9a-f]{64}$/);
});

test('shell command string is rejected', () => {
  const registry = validRegistry();
  registry.checks.unit.argv = 'npm test';
  assert.throws(
    () => validateCheckRegistry(registry, { projectRoot: PROJECT_ROOT }),
    /shell|argv|string/i,
  );
});

test('empty argv is rejected', () => {
  const registry = validRegistry();
  registry.checks.unit.argv = [];
  assert.throws(
    () => validateCheckRegistry(registry, { projectRoot: PROJECT_ROOT }),
    /empty|argv/i,
  );
});

test('unsupported schema version is rejected', () => {
  const registry = validRegistry();
  registry.schemaVersion = 99;
  assert.throws(
    () => validateCheckRegistry(registry, { projectRoot: PROJECT_ROOT }),
    /schema|version/i,
  );
});

test('artifact with parent-directory segment is rejected', () => {
  const registry = validRegistry();
  registry.checks.unit.artifacts = ['../outside.log'];
  assert.throws(
    () => validateCheckRegistry(registry, { projectRoot: PROJECT_ROOT }),
    /path|artifact|parent|\.\./i,
  );
});

test('absolute artifact path outside the project is rejected', () => {
  const registry = validRegistry();
  registry.checks.unit.artifacts = ['/etc/passwd'];
  assert.throws(
    () => validateCheckRegistry(registry, { projectRoot: PROJECT_ROOT }),
    /path|artifact|outside|project/i,
  );
});

test('usage help mentions verify run', async () => {
  const dir = tempProject();
  try {
    const result = await idefactory(dir, ['help']);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /verify run/);
    assert.match(result.out, /--check/);
  } finally {
    cleanup(dir);
  }
});

test('verify run exit zero stores a derived pass', async () => {
  const dir = tempProject();
  try {
    const attempt = await seedAttempt(dir, 0);
    ensureCleanGitCommit(dir);
    const argv = registryForExit(0).checks.unit.argv;
    const result = await idefactory(dir, [
      'verify', 'run', attempt.id, '--check', 'unit',
    ]);
    assert.equal(result.code, 0, result.err + result.out);
    const stored = getAttempt(dir, attempt.id);
    assert.equal(stored.evidence.verification.length, 1);
    const record = stored.evidence.verification[0];
    assert.equal(record.kind, 'unit');
    assert.deepEqual(record.argv, argv);
    assert.equal(record.exitCode, 0);
    assert.equal(record.passed, true);
    assert.equal(record.issuer, 'cli');
    assert.equal(record.timedOut, false);
    assert.equal(stored.evidence.red, null);
  } finally {
    cleanup(dir);
  }
});

test('verify run exit non-zero stores a non-passing record', async () => {
  const dir = tempProject();
  try {
    const attempt = await seedAttempt(dir, 1);
    const argv = registryForExit(1).checks.unit.argv;
    const result = await idefactory(dir, [
      'verify', 'run', attempt.id, '--check', 'unit',
    ]);
    assert.equal(result.code, 0, result.err + result.out);
    const stored = getAttempt(dir, attempt.id);
    assert.equal(stored.evidence.verification.length, 1);
    const record = stored.evidence.verification[0];
    assert.equal(record.kind, 'unit');
    assert.deepEqual(record.argv, argv);
    assert.equal(record.exitCode, 1);
    assert.equal(record.passed, false);
    assert.equal(record.issuer, 'cli');
    assert.equal(record.timedOut, false);
    assert.equal(stored.evidence.red, null);
  } finally {
    cleanup(dir);
  }
});

test('verify run --red stores red only on non-zero exit', async () => {
  const dir = tempProject();
  try {
    const failAttempt = await seedAttempt(dir, 1);
    const failArgv = registryForExit(1).checks.unit.argv;
    const failResult = await idefactory(dir, [
      'verify', 'run', failAttempt.id, '--check', 'unit', '--red',
    ]);
    assert.equal(failResult.code, 0, failResult.err + failResult.out);
    const failed = getAttempt(dir, failAttempt.id);
    assert.ok(failed.evidence.reds?.unit, 'red evidence must be stored on non-zero exit');
    assert.equal(failed.evidence.red, null);
    assert.equal(failed.evidence.reds.unit.kind, 'unit');
    assert.deepEqual(failed.evidence.reds.unit.argv, failArgv);
    assert.equal(failed.evidence.reds.unit.exitCode, 1);
    assert.equal(failed.evidence.reds.unit.passed, false);
    assert.equal(failed.evidence.reds.unit.issuer, 'cli');
    assert.equal(failed.evidence.reds.unit.timedOut, false);

    const passDir = tempProject();
    try {
      const passAttempt = await seedAttempt(passDir, 0);
      const passResult = await idefactory(passDir, [
        'verify', 'run', passAttempt.id, '--check', 'unit', '--red',
      ]);
      assert.notEqual(passResult.code, 0);
      assert.match(`${passResult.err}${passResult.out}`, /vacuous-red/);
      const passed = getAttempt(passDir, passAttempt.id);
      assert.equal(passed.evidence.red, null);
      assert.equal(passed.evidence.reds, undefined);
    } finally {
      cleanup(passDir);
    }
  } finally {
    cleanup(dir);
  }
});

test('caller-supplied red object is ignored unless --red and non-zero exit', async () => {
  const dir = tempProject();
  try {
    const attempt = await seedAttempt(dir, 0);
    ensureCleanGitCommit(dir);
    const forged = { command: 'forged', passed: false, kind: 'unit' };
    await verifyRun(dir, attempt.id, {
      check: 'unit',
      asRed: false,
      red: forged,
    });
    const afterPass = getAttempt(dir, attempt.id);
    assert.equal(afterPass.evidence.red, null);
    assert.notDeepEqual(afterPass.evidence.red, forged);

    const failDir = tempProject();
    try {
      const failAttempt = await seedAttempt(failDir, 1);
      await verifyRun(failDir, failAttempt.id, {
        check: 'unit',
        asRed: true,
        red: forged,
      });
      const afterFail = getAttempt(failDir, failAttempt.id);
      assert.ok(afterFail.evidence.reds?.unit);
      assert.equal(afterFail.evidence.red, null);
      assert.equal(afterFail.evidence.reds.unit.issuer, 'cli');
      assert.equal(afterFail.evidence.reds.unit.exitCode, 1);
      assert.equal(afterFail.evidence.reds.unit.passed, false);
      assert.notEqual(afterFail.evidence.reds.unit.command, 'forged');
      assert.notDeepEqual(afterFail.evidence.reds.unit, forged);
    } finally {
      cleanup(failDir);
    }
  } finally {
    cleanup(dir);
  }
});

test('clean git HEAD is stored as sourceRevision on zero exit', async () => {
  const dir = tempProject();
  try {
    const attempt = await seedAttempt(dir, 0);
    const head = ensureCleanGitCommit(dir);
    const result = await idefactory(dir, [
      'verify', 'run', attempt.id, '--check', 'unit',
    ]);
    assert.equal(result.code, 0, result.err + result.out);
    const record = getAttempt(dir, attempt.id).evidence.verification[0];
    assert.ok(record, 'verification record must be stored');
    assert.equal(record.exitCode, 0);
    assert.equal(record.passed, true);
    assert.equal(record.sourceRevision, head);
    assert.equal(record.worktreeClean, true);
  } finally {
    cleanup(dir);
  }
});

test('dirty worktree does not record a passing result', async () => {
  const dir = tempProject();
  try {
    initGitRepo(dir);
    const attempt = await seedAttempt(dir, 0);
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'uncommitted\n');
    const result = await idefactory(dir, [
      'verify', 'run', attempt.id, '--check', 'unit',
    ]);
    assert.equal(result.code, 0, result.err + result.out);
    assertNoPassingVerification(getAttempt(dir, attempt.id));
  } finally {
    cleanup(dir);
  }
});

test('factory run-state dirt does not block a pass; source dirt still does', async () => {
  const dir = tempProject();
  try {
    const attempt = await seedAttempt(dir, 0);
    // Track attempt JSON (no gitignore) so porcelain shows factory run-state dirt.
    ensureCleanGitCommit(dir);
    const attemptFile = path.join(dir, '.factory/attempts', `${attempt.id}.json`);
    assert.ok(fs.existsSync(attemptFile));
    const parsed = JSON.parse(fs.readFileSync(attemptFile, 'utf8'));
    parsed.updatedAt = new Date().toISOString();
    fs.writeFileSync(attemptFile, `${JSON.stringify(parsed, null, 2)}\n`);

    const porcelain = spawnSync('git', ['status', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
      shell: false,
    });
    assert.equal(porcelain.status, 0, porcelain.stderr || porcelain.stdout);
    assert.match(porcelain.stdout, /\.factory\/attempts\//);
    assert.doesNotMatch(porcelain.stdout, /dirty\.txt|checks\.json/);

    const passResult = await idefactory(dir, [
      'verify', 'run', attempt.id, '--check', 'unit',
    ]);
    assert.equal(passResult.code, 0, passResult.err + passResult.out);
    const passRecord = getAttempt(dir, attempt.id).evidence.verification.at(-1);
    assert.equal(passRecord?.passed, true);
    assert.equal(passRecord?.worktreeClean, true);

    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'uncommitted source\n');
    const dirtySource = await idefactory(dir, [
      'verify', 'run', attempt.id, '--check', 'unit',
    ]);
    assert.equal(dirtySource.code, 0, dirtySource.err + dirtySource.out);
    const sourceRecord = getAttempt(dir, attempt.id).evidence.verification.at(-1);
    assert.notEqual(sourceRecord?.passed, true);

    fs.unlinkSync(path.join(dir, 'dirty.txt'));
    ensureCleanGitCommit(dir);
    const checksPath = path.join(dir, '.factory/checks.json');
    const checks = JSON.parse(fs.readFileSync(checksPath, 'utf8'));
    checks.checks.unit.timeoutMs = (checks.checks.unit.timeoutMs || 30_000) + 1;
    fs.writeFileSync(checksPath, `${JSON.stringify(checks, null, 2)}\n`);
    const dirtyChecks = await idefactory(dir, [
      'verify', 'run', attempt.id, '--check', 'unit',
    ]);
    assert.equal(dirtyChecks.code, 0, dirtyChecks.err + dirtyChecks.out);
    const checksRecord = getAttempt(dir, attempt.id).evidence.verification.at(-1);
    assert.notEqual(checksRecord?.passed, true);
  } finally {
    cleanup(dir);
  }
});

test('unresolvable HEAD does not record a passing result', async () => {
  const dir = tempProject();
  try {
    const attempt = await seedAttempt(dir, 0);
    assert.equal(fs.existsSync(path.join(dir, '.git')), false);
    const result = await idefactory(dir, [
      'verify', 'run', attempt.id, '--check', 'unit',
    ]);
    assert.equal(result.code, 0, result.err + result.out);
    assertNoPassingVerification(getAttempt(dir, attempt.id));
  } finally {
    cleanup(dir);
  }
});

test('stored verify-run record includes evidence schema fields', async () => {
  const dir = tempProject();
  try {
    const artifactRel = 'coverage/lcov.info';
    const artifactBody = 'TN:demo\n';
    const script = [
      "const fs=require('fs');",
      "const path=require('path');",
      "process.stdout.write('hello-out');",
      "process.stderr.write('hello-err');",
      "fs.mkdirSync(path.join(process.cwd(),'coverage'),{recursive:true});",
      `fs.writeFileSync(path.join(process.cwd(),${JSON.stringify(artifactRel)}),${JSON.stringify(artifactBody)});`,
    ].join('');
    const registry = registryWithScript(script, [artifactRel]);
    const attempt = await seedAttempt(dir, registry);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'coverage/\n');
    const head = ensureCleanGitCommit(dir);
    const argv = registry.checks.unit.argv;
    const expectedLog = sha256Digest(Buffer.from('hello-outhello-err', 'utf8'));
    const expectedArtifact = sha256Digest(Buffer.from(artifactBody, 'utf8'));

    const result = await idefactory(dir, [
      'verify', 'run', attempt.id, '--check', 'unit',
    ]);
    assert.equal(result.code, 0, result.err + result.out);

    const stored = getAttempt(dir, attempt.id);
    assert.equal(stored.evidence.verification.length, 1);
    const record = stored.evidence.verification[0];

    assert.equal(record.schemaVersion, 1);
    assert.equal(record.kind, 'unit');
    assert.deepEqual(record.runner, { name: 'idefactory', version: PACKAGE_VERSION });
    assert.equal(record.commandDigest, commandDigest(argv));
    assert.match(record.commandDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(record.exitCode, 0);
    assert.equal(typeof record.startedAt, 'string');
    assert.equal(typeof record.finishedAt, 'string');
    assert.ok(Date.parse(record.startedAt) <= Date.parse(record.finishedAt));
    assert.equal(record.sourceRevision, head);
    assert.equal(record.worktreeClean, true);
    assert.equal(record.logDigest, expectedLog);
    assert.deepEqual(record.artifactDigests, [
      { path: artifactRel, digest: expectedArtifact },
    ]);
    assert.equal(record.attemptId, attempt.id);
    assert.equal(record.passed, true);
  } finally {
    cleanup(dir);
  }
});

test('missing declared artifact stores a non-passing record with schema fields', async () => {
  const dir = tempProject();
  try {
    const head = initGitRepo(dir);
    const artifactRel = 'coverage/missing.info';
    const registry = registryWithScript(
      "process.stdout.write('ok'); process.exit(0);",
      [artifactRel],
    );
    const attempt = await seedAttempt(dir, registry);
    const argv = registry.checks.unit.argv;

    const result = await idefactory(dir, [
      'verify', 'run', attempt.id, '--check', 'unit',
    ]);
    assert.equal(result.code, 0, result.err + result.out);

    const record = getAttempt(dir, attempt.id).evidence.verification[0];
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.kind, 'unit');
    assert.deepEqual(record.runner, { name: 'idefactory', version: PACKAGE_VERSION });
    assert.equal(record.commandDigest, commandDigest(argv));
    assert.equal(record.exitCode, 0);
    assert.ok(record.startedAt);
    assert.ok(record.finishedAt);
    assert.equal(record.sourceRevision, head);
    assert.equal(record.logDigest, sha256Digest(Buffer.from('ok', 'utf8')));
    assert.deepEqual(record.artifactDigests, []);
    assert.equal(record.attemptId, attempt.id);
    assert.equal(record.passed, false);
  } finally {
    cleanup(dir);
  }
});

test('validateCheckRecord rejects a record with no exitCode', () => {
  assert.throws(
    () => validateCheckRecord({
      schemaVersion: 1,
      kind: 'unit',
      runner: { name: 'idefactory', version: PACKAGE_VERSION },
      commandDigest: commandDigest(['npm', 'test']),
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      sourceRevision: 'abc123',
      logDigest: sha256Digest(Buffer.alloc(0)),
      artifactDigests: [],
      attemptId: 'attempt-1',
    }),
    /exitCode/i,
  );
});

test('verify refuses when HALT is present and writes no evidence', async () => {
  const dir = tempProject();
  const haltPath = path.join(dir, 'HALT');
  try {
    const attempt = await seedAttempt(dir, 0);
    const before = getAttempt(dir, attempt.id);
    assert.deepEqual(before.evidence.verification || [], []);
    assert.equal(before.evidence.red, null);

    fs.writeFileSync(haltPath, 'stop\n');
    try {
      const result = await idefactory(dir, [
        'verify', 'run', attempt.id, '--check', 'unit',
      ]);
      assert.notEqual(result.code, 0);
      assert.match(result.err, /HALT/);

      await assert.rejects(
        () => verifyRun(dir, attempt.id, { check: 'unit' }),
        /HALT/,
      );

      const after = getAttempt(dir, attempt.id);
      assert.deepEqual(after.evidence.verification || [], []);
      assert.equal(after.evidence.red, null);
      assert.deepEqual(after.evidence, before.evidence);
    } finally {
      if (fs.existsSync(haltPath)) fs.unlinkSync(haltPath);
    }
  } finally {
    if (fs.existsSync(haltPath)) fs.unlinkSync(haltPath);
    cleanup(dir);
  }
});

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function generateImportKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    id: 'test-import-key',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey,
  };
}

function unitRegistryWithImportKeys(importKeys, argv = ['npm', 'test']) {
  return {
    schemaVersion: 1,
    importKeys: importKeys.map(({ id, publicKeyPem }) => ({ id, publicKeyPem })),
    checks: {
      unit: {
        argv,
        cwdPolicy: 'project',
        timeoutMs: 30_000,
        artifacts: [],
      },
    },
  };
}

function buildSignedAttestation({
  attemptId,
  argv,
  sourceRevision,
  privateKey,
  keyId,
  exitCode = 0,
  overrides = {},
}) {
  const attestation = {
    schemaVersion: 1,
    kind: 'unit',
    runner: { name: 'idefactory', version: PACKAGE_VERSION },
    argv: [...argv],
    commandDigest: commandDigest(argv),
    cwdPolicy: 'project',
    exitCode,
    timedOut: false,
    startedAt: '2026-10-21T12:00:00.000Z',
    finishedAt: '2026-10-21T12:00:01.000Z',
    sourceRevision,
    worktreeClean: true,
    logDigest: sha256Digest(Buffer.from('import-log', 'utf8')),
    artifactDigests: [],
    attemptId,
    keyId,
    passed: true,
    ...overrides,
  };
  const payload = { ...attestation };
  delete payload.signature;
  const data = Buffer.from(canonicalJson(payload), 'utf8');
  attestation.signature = sign(null, data, privateKey).toString('base64');
  return attestation;
}

async function seedImportFixture(options = {}) {
  const dir = tempProject();
  const key = generateImportKey();
  const argv = options.argv || ['npm', 'test'];
  const registry = options.registry || unitRegistryWithImportKeys([key], argv);
  const attempt = await seedAttempt(dir, registry);
  const head = ensureCleanGitCommit(dir);
  const attestDir = mkdtempSync(path.join(tmpdir(), 'idefactory-attest-'));
  return { dir, key, argv, attempt, head, attestDir };
}

function cleanupImportFixture({ dir, attestDir }) {
  cleanup(dir);
  if (attestDir) cleanup(attestDir);
}

test('usage help mentions verify import', async () => {
  const dir = tempProject();
  try {
    const result = await idefactory(dir, ['help']);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /verify import/);
    assert.match(result.out, /--file/);
  } finally {
    cleanup(dir);
  }
});

test('signature-valid import with matching digest and attempt id is stored', async () => {
  const fixture = await seedImportFixture();
  const { dir, key, argv, attempt, head, attestDir } = fixture;
  try {
    const attestation = buildSignedAttestation({
      attemptId: attempt.id,
      argv,
      sourceRevision: head,
      privateKey: key.privateKey,
      keyId: key.id,
    });
    const file = path.join(attestDir, 'attestation.json');
    fs.writeFileSync(file, `${JSON.stringify(attestation, null, 2)}\n`);

    const result = await idefactory(dir, [
      'verify', 'import', attempt.id, '--file', file,
    ]);
    assert.equal(result.code, 0, result.err + result.out);

    const stored = getAttempt(dir, attempt.id);
    assert.equal(stored.evidence.verification.length, 1);
    const record = stored.evidence.verification[0];
    assert.equal(record.kind, 'unit');
    assert.equal(record.attemptId, attempt.id);
    assert.equal(record.commandDigest, commandDigest(argv));
    assert.equal(record.exitCode, 0);
    assert.equal(record.passed, true);
    assert.equal(record.issuer, 'import');
    assert.equal(record.sourceRevision, head);
    assert.equal(stored.evidence.red, null);
  } finally {
    cleanupImportFixture(fixture);
  }
});

test('import derives passed from exitCode and never writes red', async () => {
  const fixture = await seedImportFixture();
  const { dir, key, argv, attempt, head, attestDir } = fixture;
  try {
    const attestation = buildSignedAttestation({
      attemptId: attempt.id,
      argv,
      sourceRevision: head,
      privateKey: key.privateKey,
      keyId: key.id,
      exitCode: 1,
      overrides: { passed: true },
    });
    const file = path.join(attestDir, 'attestation-nonzero.json');
    fs.writeFileSync(file, `${JSON.stringify(attestation, null, 2)}\n`);

    const result = await idefactory(dir, [
      'verify', 'import', attempt.id, '--file', file,
    ]);
    assert.equal(result.code, 0, result.err + result.out);

    const stored = getAttempt(dir, attempt.id);
    assert.equal(stored.evidence.verification.length, 1);
    assert.equal(stored.evidence.verification[0].exitCode, 1);
    assert.equal(stored.evidence.verification[0].passed, false);
    assert.equal(stored.evidence.verification[0].issuer, 'import');
    assert.equal(stored.evidence.red, null);
  } finally {
    cleanupImportFixture(fixture);
  }
});

test('invalid signature is rejected with no evidence added', async () => {
  const fixture = await seedImportFixture();
  const { dir, key, argv, attempt, head, attestDir } = fixture;
  try {
    const attestation = buildSignedAttestation({
      attemptId: attempt.id,
      argv,
      sourceRevision: head,
      privateKey: key.privateKey,
      keyId: key.id,
    });
    const sig = Buffer.from(attestation.signature, 'base64');
    sig[0] ^= 0xff;
    attestation.signature = sig.toString('base64');

    const before = getAttempt(dir, attempt.id);
    const file = path.join(attestDir, 'bad-sig.json');
    fs.writeFileSync(file, `${JSON.stringify(attestation, null, 2)}\n`);

    const result = await idefactory(dir, [
      'verify', 'import', attempt.id, '--file', file,
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.err, /signature|invalid/i);

    const after = getAttempt(dir, attempt.id);
    assert.deepEqual(after.evidence.verification || [], []);
    assert.equal(after.evidence.red, null);
    assert.deepEqual(after.evidence, before.evidence);
  } finally {
    cleanupImportFixture(fixture);
  }
});

test('missing registry importKeys is rejected with no evidence added', async () => {
  const dir = tempProject();
  const attestDir = mkdtempSync(path.join(tmpdir(), 'idefactory-attest-'));
  try {
    const key = generateImportKey();
    const argv = ['npm', 'test'];
    const registry = unitRegistryWithImportKeys([key], argv);
    delete registry.importKeys;
    const attempt = await seedAttempt(dir, registry);
    const head = ensureCleanGitCommit(dir);
    const attestation = buildSignedAttestation({
      attemptId: attempt.id,
      argv,
      sourceRevision: head,
      privateKey: key.privateKey,
      keyId: key.id,
    });
    const before = getAttempt(dir, attempt.id);
    const file = path.join(attestDir, 'attestation.json');
    fs.writeFileSync(file, `${JSON.stringify(attestation, null, 2)}\n`);

    const result = await idefactory(dir, [
      'verify', 'import', attempt.id, '--file', file,
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.err, /importKeys|key/i);

    const after = getAttempt(dir, attempt.id);
    assert.deepEqual(after.evidence.verification || [], []);
    assert.equal(after.evidence.red, null);
    assert.deepEqual(after.evidence, before.evidence);
  } finally {
    cleanup(dir);
    cleanup(attestDir);
  }
});

test('unknown import key id is rejected with no evidence added', async () => {
  const fixture = await seedImportFixture();
  const { dir, argv, attempt, head, attestDir } = fixture;
  try {
    const other = generateImportKey();
    const attestation = buildSignedAttestation({
      attemptId: attempt.id,
      argv,
      sourceRevision: head,
      privateKey: other.privateKey,
      keyId: 'unknown-key',
    });
    const before = getAttempt(dir, attempt.id);
    const file = path.join(attestDir, 'attestation.json');
    fs.writeFileSync(file, `${JSON.stringify(attestation, null, 2)}\n`);

    const result = await idefactory(dir, [
      'verify', 'import', attempt.id, '--file', file,
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.err, /key|unknown/i);

    const after = getAttempt(dir, attempt.id);
    assert.deepEqual(after.evidence.verification || [], []);
    assert.equal(after.evidence.red, null);
    assert.deepEqual(after.evidence, before.evidence);
  } finally {
    cleanupImportFixture(fixture);
  }
});

test('attestation for a different attempt id is rejected with no evidence added', async () => {
  const fixture = await seedImportFixture();
  const { dir, key, argv, attempt, attestDir } = fixture;
  try {
    const otherAttempt = await seedAttempt(dir, unitRegistryWithImportKeys([key], argv));
    const head = ensureCleanGitCommit(dir);
    const attestation = buildSignedAttestation({
      attemptId: otherAttempt.id,
      argv,
      sourceRevision: head,
      privateKey: key.privateKey,
      keyId: key.id,
    });
    const before = getAttempt(dir, attempt.id);
    const file = path.join(attestDir, 'attestation.json');
    fs.writeFileSync(file, `${JSON.stringify(attestation, null, 2)}\n`);

    const result = await idefactory(dir, [
      'verify', 'import', attempt.id, '--file', file,
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.err, /attempt/i);

    const after = getAttempt(dir, attempt.id);
    assert.deepEqual(after.evidence.verification || [], []);
    assert.equal(after.evidence.red, null);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(
      getAttempt(dir, otherAttempt.id).evidence.verification || [],
      [],
    );
  } finally {
    cleanupImportFixture(fixture);
  }
});

test('import rejects dirty worktree or mismatched sourceRevision with no evidence', async () => {
  const fixture = await seedImportFixture();
  const { dir, key, argv, attempt, head, attestDir } = fixture;
  try {
    const mismatched = buildSignedAttestation({
      attemptId: attempt.id,
      argv,
      sourceRevision: '0'.repeat(40),
      privateKey: key.privateKey,
      keyId: key.id,
    });
    const before = getAttempt(dir, attempt.id);
    const mismatchFile = path.join(attestDir, 'mismatch-rev.json');
    fs.writeFileSync(mismatchFile, `${JSON.stringify(mismatched, null, 2)}\n`);
    const mismatchResult = await idefactory(dir, [
      'verify', 'import', attempt.id, '--file', mismatchFile,
    ]);
    assert.notEqual(mismatchResult.code, 0);
    assert.match(mismatchResult.err, /sourceRevision|revision/i);
    assert.deepEqual(getAttempt(dir, attempt.id).evidence, before.evidence);

    const valid = buildSignedAttestation({
      attemptId: attempt.id,
      argv,
      sourceRevision: head,
      privateKey: key.privateKey,
      keyId: key.id,
    });
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'uncommitted\n');
    const dirtyFile = path.join(attestDir, 'dirty-attestation.json');
    fs.writeFileSync(dirtyFile, `${JSON.stringify(valid, null, 2)}\n`);
    const dirtyResult = await idefactory(dir, [
      'verify', 'import', attempt.id, '--file', dirtyFile,
    ]);
    assert.notEqual(dirtyResult.code, 0);
    assert.match(dirtyResult.err, /dirty|worktree|clean/i);
    assert.deepEqual(getAttempt(dir, attempt.id).evidence, before.evidence);
    assert.equal(getAttempt(dir, attempt.id).evidence.red, null);
  } finally {
    cleanupImportFixture(fixture);
  }
});

test('verify import refuses when HALT is present and writes no evidence', async () => {
  const fixture = await seedImportFixture();
  const { dir, key, argv, attempt, head, attestDir } = fixture;
  const haltPath = path.join(dir, 'HALT');
  try {
    const attestation = buildSignedAttestation({
      attemptId: attempt.id,
      argv,
      sourceRevision: head,
      privateKey: key.privateKey,
      keyId: key.id,
    });
    const file = path.join(attestDir, 'attestation.json');
    fs.writeFileSync(file, `${JSON.stringify(attestation, null, 2)}\n`);
    const before = getAttempt(dir, attempt.id);

    fs.writeFileSync(haltPath, 'stop\n');
    try {
      const result = await idefactory(dir, [
        'verify', 'import', attempt.id, '--file', file,
      ]);
      assert.notEqual(result.code, 0);
      assert.match(result.err, /HALT/);

      const { verifyImport } = await import('../src/lib/verification-evidence.mjs');
      await assert.rejects(
        () => verifyImport(dir, attempt.id, { file }),
        /HALT/,
      );

      const after = getAttempt(dir, attempt.id);
      assert.deepEqual(after.evidence.verification || [], []);
      assert.equal(after.evidence.red, null);
      assert.deepEqual(after.evidence, before.evidence);
    } finally {
      if (fs.existsSync(haltPath)) fs.unlinkSync(haltPath);
    }
  } finally {
    if (fs.existsSync(haltPath)) fs.unlinkSync(haltPath);
    cleanupImportFixture(fixture);
  }
});

test('implementation notes record strict validate, npm test, and doctor', () => {
  const notesPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../openspec/changes/archive/2026-10-22-enforce-verification-evidence/implementation-notes.md',
  );
  assert.ok(
    fs.existsSync(notesPath),
    `missing implementation notes: ${notesPath}`,
  );
  const notes = fs.readFileSync(notesPath, 'utf8');
  assert.match(notes, /npx openspec validate enforce-verification-evidence --strict/);
  assert.match(notes, /npm test/);
  assert.match(notes, /node src\/cli\.mjs doctor/);
});

test('red runs keep each kind and classify infrastructure, vacuous red, and assertion failure', async () => {
  const dir = tempProject();
  try {
    const attempt = await seedAttempt(dir, 1);
    const registry = {
      schemaVersion: 1,
      checks: {
        unit: registryForExit(1).checks.unit,
        integration: registryForExit(1).checks.unit,
      },
    };
    fs.writeFileSync(path.join(dir, '.factory/checks.json'), `${JSON.stringify(registry, null, 2)}\n`);
    assert.equal((await idefactory(dir, ['verify', 'run', attempt.id, '--check', 'unit', '--red'])).code, 0);
    assert.equal((await idefactory(dir, ['verify', 'run', attempt.id, '--check', 'integration', '--red'])).code, 0);
    const stored = getAttempt(dir, attempt.id);
    assert.equal(stored.evidence.red, null);
    assert.equal(stored.evidence.reds.unit.kind, 'unit');
    assert.equal(stored.evidence.reds.integration.kind, 'integration');
    assert.equal(stored.evidence.reds.unit.passed, false);
    assert.equal(stored.evidence.reds.integration.passed, false);

    fs.writeFileSync(path.join(dir, '.factory/checks.json'), `${JSON.stringify({
      schemaVersion: 1,
      checks: {
        unit: {
          argv: ['definitely-missing-idefactory-bin'],
          cwdPolicy: 'project',
          timeoutMs: 5000,
          artifacts: [],
        },
        integration: registry.checks.integration,
      },
    }, null, 2)}\n`);
    const infra = await idefactory(dir, ['verify', 'run', attempt.id, '--check', 'unit', '--red']);
    assert.notEqual(infra.code, 0);
    assert.match(infra.err, /infrastructure-failure/);
    assert.equal(getAttempt(dir, attempt.id).evidence.reds.integration.kind, 'integration');
    assert.equal(getAttempt(dir, attempt.id).evidence.reds.unit.exitCode, 1);

    fs.writeFileSync(path.join(dir, '.factory/checks.json'), `${JSON.stringify({
      schemaVersion: 1,
      checks: {
        unit: {
          argv: [process.execPath, '-e', "console.error('no tests'); process.exit(1)"],
          cwdPolicy: 'project',
          timeoutMs: 5000,
          artifacts: [],
        },
      },
    }, null, 2)}\n`);
    const none = await idefactory(dir, ['verify', 'run', attempt.id, '--check', 'unit', '--red']);
    assert.notEqual(none.code, 0);
    assert.match(none.err, /infrastructure-failure/);
  } finally {
    cleanup(dir);
  }
});

test('legacy evidence.red satisfies unit and verifying requires every code test kind', async () => {
  const legacyDir = tempProject();
  try {
    const attempt = await seedAttempt(legacyDir, 0);
    const file = path.join(legacyDir, '.factory', 'attempts', `${attempt.id}.json`);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.evidence.red = {
      schemaVersion: 1,
      kind: 'unit',
      issuer: 'cli',
      exitCode: 1,
      passed: false,
      timedOut: false,
    };
    delete stored.evidence.reds;
    fs.writeFileSync(file, JSON.stringify(stored, null, 2));
    assert.equal((await idefactory(legacyDir, ['attempt', 'transition', attempt.id, 'implementing', '--evidence', JSON.stringify({ implementerId: 'engineer-1' })])).code, 0);
    assert.equal((await idefactory(legacyDir, ['attempt', 'transition', attempt.id, 'red-confirmed'])).code, 0);
    const verified = await idefactory(legacyDir, ['attempt', 'transition', attempt.id, 'verifying']);
    assert.equal(verified.code, 0, verified.err);
  } finally {
    cleanup(legacyDir);
  }

  const dir = tempProject();
  try {
    const attempt = await seedAttempt(dir, 1);
    const registry = {
      schemaVersion: 1,
      checks: {
        unit: registryForExit(1).checks.unit,
        integration: registryForExit(1).checks.unit,
      },
    };
    fs.writeFileSync(path.join(dir, '.factory/checks.json'), `${JSON.stringify(registry, null, 2)}\n`);
    assert.equal((await idefactory(dir, ['verify', 'run', attempt.id, '--check', 'unit', '--red'])).code, 0);
    const itemPath = path.join(dir, '.factory/work/items/demo--1.1.json');
    const item = JSON.parse(fs.readFileSync(itemPath, 'utf8'));
    item.factory.checks = ['unit', 'integration'];
    item.factory.taskType = 'code';
    fs.writeFileSync(itemPath, JSON.stringify(item, null, 2));
    assert.equal((await idefactory(dir, ['attempt', 'transition', attempt.id, 'implementing', '--evidence', JSON.stringify({ implementerId: 'engineer-1' })])).code, 0);
    assert.equal((await idefactory(dir, ['attempt', 'transition', attempt.id, 'red-confirmed'])).code, 0);
    const blocked = await idefactory(dir, ['attempt', 'transition', attempt.id, 'verifying']);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.err, /integration/);
    assert.equal(getAttempt(dir, attempt.id).state, 'red-confirmed');
  } finally {
    cleanup(dir);
  }
});

test('a lightweight attempt enters verifying with no red record', async () => {
  const dir = tempProject();
  try {
    const attempt = await seedAttempt(dir, 0);
    const itemPath = path.join(dir, '.factory/work/items/demo--1.1.json');
    const item = JSON.parse(fs.readFileSync(itemPath, 'utf8'));
    item.factory.taskType = 'lightweight';
    item.factory.checks = ['unit'];
    fs.writeFileSync(itemPath, JSON.stringify(item, null, 2));
    assert.equal((await idefactory(dir, ['attempt', 'transition', attempt.id, 'implementing', '--evidence', JSON.stringify({ implementerId: 'engineer-1' })])).code, 0);
    const moved = await idefactory(dir, ['attempt', 'transition', attempt.id, 'verifying']);
    assert.equal(moved.code, 0, moved.err);
    assert.equal(getAttempt(dir, attempt.id).state, 'verifying');
    assert.equal(getAttempt(dir, attempt.id).evidence.red, null);
  } finally {
    cleanup(dir);
  }
});

test('installed factory-verify names verify run and does not supply a pass boolean', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const skill = fs.readFileSync(path.join(dir, '.cursor/skills/factory-verify/SKILL.md'), 'utf8');
    assert.match(skill, /idefactory verify run/);
    assert.match(skill, /--red/);
    assert.match(skill, /vacuous-red/);
    assert.match(skill, /infrastructure-failure/);
    assert.doesNotMatch(skill, /passed"\s*:/);
    assert.doesNotMatch(skill, /pass boolean/i);
  } finally {
    cleanup(dir);
  }
});
