import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'ci.yml');
const releaseWorkflowPath = path.join(repoRoot, '.github', 'workflows', 'release.yml');
const lockfilePath = path.join(repoRoot, 'package-lock.json');
const secretlintRcPath = path.join(repoRoot, '.secretlintrc.json');

/** Pinned @cyclonedx/cyclonedx-npm version recorded in release CI. */
const CYCLONEDX_NPM_VERSION = '6.0.1';

/** Shared release SBOM generator (exact string must appear as a CI run step). */
const CYCLONEDX_COMMAND =
  `npx @cyclonedx/cyclonedx-npm@${CYCLONEDX_NPM_VERSION} --package-lock-only --output-file release/sbom.cdx.json`;

/** Post-step that records lockfile digest and source revision in SBOM metadata. */
const ANNOTATE_SBOM_COMMAND = 'node scripts/annotate-release-sbom.mjs release/sbom.cdx.json';

/** Final SBOM path attested after annotation (exact string in release workflow). */
const SBOM_SUBJECT_PATH = 'release/sbom.cdx.json';

/** Pinned actions/attest-build-provenance commit (v4.2.2). */
const ATTEST_BUILD_PROVENANCE_SHA = '4d101475d8b20a2381f78447822ac1eab6504dd8';

const SBOM_LOCKFILE_PROPERTY = 'lockfile-sha256';
const SBOM_SOURCE_REVISION_PROPERTY = 'source-revision';

const BASELINE_COMMANDS = [
  'npm ci',
  'npm test',
  'npm audit --audit-level=high',
  'npx openspec validate --all',
];

/** Shared local/CI secretlint invocation (exact string must appear as a CI run step). */
const SECRETLINT_COMMAND = 'npx secretlint "**/*"';

/**
 * Shared local/CI Semgrep wrapper (exact string must appear as a CI run step).
 * Invokes Semgrep with --error --metrics=off --config p/javascript when present.
 */
const SEMGREP_COMMAND = 'node scripts/run-semgrep.mjs';

/** Semgrep v1.182.0 release commit and manylinux x86_64 wheel digest. */
const SEMGREP_GIT_SHA = '240da9f30cd06fb4ee00c2c31c114c1c1f5ee0f4';
const SEMGREP_VERSION = '1.182.0';
const SEMGREP_WHEEL_SHA256 = '19a82868830389c039bb71bfc0aeebb28385e5b65740120710eff050324ad14f';
const SETUP_PYTHON_SHA = 'a26af69be951a213d495a4c3e4e4022e16d87065';

/** Required Semgrep argv after the binary name. */
const SEMGREP_ARGS = ['--error', '--metrics=off', '--config', 'p/javascript'];

/**
 * Deterministic high-confidence Slack bot token fixture — not a live credential.
 * Built at runtime so the contiguous token never appears in the committed tree.
 */
const SEEDED_SLACK_BOT_TOKEN = Buffer.from(
  'eG94Yi0xMjM0NTY3ODkwMTItMTIzNDU2Nzg5MDEyMy1BYkNkRWZHaElqS2xNbk9wUXJTdFV2V3g=',
  'base64',
).toString('utf8');

function readWorkflow() {
  assert.ok(fs.existsSync(workflowPath), `missing ${workflowPath}`);
  return fs.readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n');
}

function assertNodeVersion24(yaml, label) {
  const versions = [...yaml.matchAll(/\bnode-version\s*:\s*['"]?(\d+)['"]?/g)].map((match) => match[1]);
  assert.ok(versions.length > 0, `${label} must set node-version`);
  for (const version of versions) {
    assert.equal(version, '24', `${label} must pin node-version 24, found ${version}`);
  }
}

function baselineJobBlock(yaml) {
  const match = yaml.match(/(?:^|\n)(\s*)baseline\s*:\s*\n([\s\S]*?)(?=\n\1[A-Za-z0-9_-]+\s*:\s*\n|\n*$)/);
  assert.ok(match, 'workflow must define a job named baseline');
  return match[2];
}

function runSteps(jobBody) {
  const steps = [];
  const stepBlocks = jobBody.split(/\n\s*-\s+/).slice(1);
  for (const block of stepBlocks) {
    const runMatch = block.match(/\brun\s*:\s*(?:\|\s*\n([\s\S]*?)(?=\n\s*\w|\n*$)|(.+))/);
    if (!runMatch) continue;
    const body = (runMatch[1] || runMatch[2] || '').trim();
    const command = body.split('\n')[0].trim();
    const continueOnError = /^\s*continue-on-error\s*:\s*true\s*$/m.test(block)
      || /\n\s+continue-on-error\s*:\s*true\s*(?:\n|$)/.test(`\n${block}`);
    steps.push({ command, continueOnError, raw: block });
  }
  return steps;
}

/** Top-level keys under `on:`. Nested mappings stay on the current key. */
function workflowOnEntries(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line === 'on:');
  assert.notEqual(start, -1, 'workflow must declare on triggers');
  const entries = [];
  let current = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (!line.startsWith('  ')) break;
    const key = line.match(/^  ([A-Za-z0-9_-]+):\s*(.*)$/);
    if (key && !line.startsWith('   ')) {
      current = { name: key[1], rest: key[2].trim(), body: [] };
      entries.push(current);
      continue;
    }
    assert.ok(current, `unexpected trigger detail: ${line}`);
    current.body.push(line);
  }
  return entries;
}

test('baseline CI job runs the four Phase 0 commands on pull requests and pushes to main with Node 24', () => {
  const yaml = readWorkflow();
  const triggers = workflowOnEntries(yaml);

  assert.deepEqual(
    triggers.map((entry) => entry.name),
    ['pull_request', 'push'],
    'CI must run on pull requests and on pushes, with no other trigger',
  );
  assert.deepEqual(
    triggers[0],
    { name: 'pull_request', rest: '', body: [] },
    'pull_request must stay unfiltered so required checks still run on pull requests',
  );
  assert.deepEqual(
    triggers[1],
    { name: 'push', rest: '', body: ['    branches:', '      - main'] },
    'push must be limited to main so a push to an open pull request branch starts CI once',
  );

  const job = baselineJobBlock(yaml);
  assert.match(job, /\bnode-version\s*:\s*['"]?24['"]?\b/, 'baseline job must use Node 24');
  assertNodeVersion24(yaml, 'ci.yml');
  assertNodeVersion24(readReleaseWorkflow(), 'release.yml');

  const steps = runSteps(job);
  const commands = steps.map((step) => step.command);
  for (const required of BASELINE_COMMANDS) {
    assert.ok(
      commands.some((command) => command === required || command.startsWith(`${required} `)),
      `baseline job must run \`${required}\`; found: ${JSON.stringify(commands)}`,
    );
  }

  for (const required of BASELINE_COMMANDS) {
    const step = steps.find(
      (candidate) => candidate.command === required || candidate.command.startsWith(`${required} `),
    );
    assert.ok(step, `missing run step for ${required}`);
    assert.equal(
      step.continueOnError,
      false,
      `\`${required}\` must fail the job on non-zero exit (no continue-on-error)`,
    );
  }
});

const FULL_SHA = /^[0-9a-f]{40}$/;

function thirdPartyUses(yaml) {
  const refs = [];
  for (const line of yaml.split('\n')) {
    const match = line.match(/^\s*-\s*uses\s*:\s*(.+?)\s*$/);
    if (!match) continue;
    const raw = match[1].replace(/\s+#.*$/, '').trim();
    // Local or reusable workflow refs are not third-party marketplace actions.
    if (raw.startsWith('./') || raw.startsWith('.github/') || raw.startsWith('docker://')) continue;
    refs.push(raw);
  }
  return refs;
}

test('baseline workflow uses contents:read, full-SHA action pins, and forbids pull_request_target and continue-on-error', () => {
  const yaml = readWorkflow();

  assert.match(
    yaml,
    /^\s*permissions\s*:\s*\n(?:\s+.+\n)*?\s+contents\s*:\s*read\s*$/m,
    'workflow must set permissions.contents to read',
  );
  assert.doesNotMatch(
    yaml,
    /^\s*contents\s*:\s*write\b/m,
    'workflow must not request contents: write',
  );

  assert.doesNotMatch(
    yaml,
    /\bpull_request_target\b/,
    'workflow must not use pull_request_target',
  );
  assert.doesNotMatch(
    yaml,
    /^\s*continue-on-error\s*:\s*true\s*$/m,
    'workflow must not set continue-on-error: true',
  );

  const uses = thirdPartyUses(yaml);
  assert.ok(uses.length > 0, 'baseline workflow must use at least one third-party action');
  for (const ref of uses) {
    const at = ref.lastIndexOf('@');
    assert.ok(at > 0, `action ref must include @pin: ${ref}`);
    const pin = ref.slice(at + 1);
    assert.ok(
      FULL_SHA.test(pin),
      `third-party action must be pinned to a full 40-char commit SHA (not a tag/branch): ${ref}`,
    );
  }
});

function secretScanJobBlock(yaml) {
  const match = yaml.match(/(?:^|\n)(\s*)secret-scan\s*:\s*\n([\s\S]*?)(?=\n\1[A-Za-z0-9_-]+\s*:\s*\n|\n*$)/);
  assert.ok(match, 'workflow must define a job named secret-scan');
  return match[2];
}

function runSharedSecretlint(cwd) {
  const binDir = path.join(repoRoot, 'node_modules', '.bin');
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
  };
  return spawnSync(SECRETLINT_COMMAND, {
    cwd,
    env,
    encoding: 'utf8',
    shell: true,
  });
}

/** Live secretlint and Semgrep binaries are exercised on Linux, matching CI. */
const linuxToolRun = {
  skip: process.platform === 'linux' ? false : 'Linux tool invocation',
};

function prepareSecretlintFixture(contentsByRelativePath) {
  assert.ok(fs.existsSync(secretlintRcPath), `missing ${secretlintRcPath}`);
  const dir = mkdtempSync(path.join(tmpdir(), 'secretlint-fixture-'));
  fs.copyFileSync(secretlintRcPath, path.join(dir, '.secretlintrc.json'));
  // Same command as CI resolves rules from cwd; link the repo install into the temp tree.
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  for (const [relative, body] of Object.entries(contentsByRelativePath)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, 'utf8');
  }
  return dir;
}

test('secret-scan job runs the shared secretlint command without continue-on-error', () => {
  const yaml = readWorkflow();
  const job = secretScanJobBlock(yaml);
  const steps = runSteps(job);
  const commands = steps.map((step) => step.command);
  assert.ok(
    commands.includes(SECRETLINT_COMMAND),
    `secret-scan job must run \`${SECRETLINT_COMMAND}\`; found: ${JSON.stringify(commands)}`,
  );
  const secretStep = steps.find((step) => step.command === SECRETLINT_COMMAND);
  assert.equal(
    secretStep.continueOnError,
    false,
    `\`${SECRETLINT_COMMAND}\` must fail the job on non-zero exit (no continue-on-error)`,
  );
});

test('shared secretlint command fails on seeded secret, passes clean tree, and masks the secret', linuxToolRun, () => {
  let dirtyDir;
  let cleanDir;
  try {
    dirtyDir = prepareSecretlintFixture({
      'seed.env': `SLACK_TOKEN=${SEEDED_SLACK_BOT_TOKEN}\n`,
    });
    const dirty = runSharedSecretlint(dirtyDir);
    const dirtyOutput = `${dirty.stdout || ''}${dirty.stderr || ''}`;
    assert.notEqual(
      dirty.status,
      0,
      `seeded secret must make secretlint exit non-zero; output:\n${dirtyOutput}`,
    );
    assert.ok(
      !dirtyOutput.includes(SEEDED_SLACK_BOT_TOKEN),
      'secretlint output must not contain the seeded secret value',
    );

    cleanDir = prepareSecretlintFixture({
      'notes.txt': 'no credentials here\n',
    });
    const clean = runSharedSecretlint(cleanDir);
    const cleanOutput = `${clean.stdout || ''}${clean.stderr || ''}`;
    assert.equal(
      clean.status,
      0,
      `clean tree must make secretlint exit zero; output:\n${cleanOutput}`,
    );
  } finally {
    if (dirtyDir) rmSync(dirtyDir, { recursive: true, force: true });
    if (cleanDir) rmSync(cleanDir, { recursive: true, force: true });
  }
});

function sastJobBlock(yaml) {
  const match = yaml.match(/(?:^|\n)(\s*)sast\s*:\s*\n([\s\S]*?)(?=\n\1[A-Za-z0-9_-]+\s*:\s*\n|\n*$)/);
  assert.ok(match, 'workflow must define a job named sast');
  return match[2];
}

function nodeBinDir() {
  return path.dirname(process.execPath);
}

/**
 * Run the shared Semgrep command with a controlled PATH (stub or absent binary only).
 * Never relies on a real Semgrep install and never installs one.
 */
function runSharedSemgrep({ args = [], pathDirs = [], cwd = repoRoot } = {}) {
  const env = {
    ...process.env,
    PATH: [...pathDirs, nodeBinDir()].join(path.delimiter),
  };
  // Drop leftover user installs so tests cannot accidentally invoke a real binary.
  delete env.PYTHONPATH;
  delete env.PIP_USER;
  return spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'run-semgrep.mjs'), ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
}

function writeExecutable(filePath, body) {
  fs.writeFileSync(filePath, body, { mode: 0o755 });
}

test('sast job installs a pinned Semgrep release and does not skip or continue on error', () => {
  const yaml = readWorkflow();

  const baseline = baselineJobBlock(yaml);
  assert.doesNotMatch(
    baseline,
    /--skip-semgrep/,
    'baseline CI must not pass --skip-semgrep',
  );

  const job = sastJobBlock(yaml);
  assert.doesNotMatch(
    job,
    /^\s*continue-on-error\s*:\s*true\s*$/m,
    'sast job must not set continue-on-error: true',
  );
  assert.doesNotMatch(
    job,
    /--skip-semgrep/,
    'sast job must not pass --skip-semgrep',
  );
  assert.match(
    job,
    new RegExp(`actions/setup-python@${SETUP_PYTHON_SHA}\\b`),
    'sast job must pin actions/setup-python to a full commit SHA',
  );
  assert.match(
    job,
    /python-version\s*:\s*['"]3\.14['"]/,
    'sast job must use Python 3.14',
  );
  assert.match(job, new RegExp(`\\bsemgrep==${SEMGREP_VERSION.replace(/\./g, '\\.')}\\b`));
  assert.match(job, new RegExp(`\\b${SEMGREP_GIT_SHA}\\b`), 'sast install must pin the Semgrep release commit');
  assert.match(job, new RegExp(`\\b${SEMGREP_WHEEL_SHA256}\\b`), 'sast install must pin the Semgrep wheel sha256');
  const pinnedInstall = job.match(/semgrep==1\.182\.0([\s\S]*?)- run: node scripts\/run-semgrep\.mjs/);
  assert.ok(pinnedInstall, 'pinned Semgrep install must be immediately before the scan');
  assert.doesNotMatch(
    pinnedInstall[1],
    /^\s*-\s+(?:uses|run|name)\s*:/m,
    'no step may sit between the Semgrep install and the scan',
  );
  assert.match(job, /sha256sum\s+-c/, 'sast install must fail closed when the wheel digest does not match');
  const installSource = fs.readFileSync(path.join(repoRoot, 'src/lib/install.mjs'), 'utf8');
  assert.doesNotMatch(installSource, /\.github\/workflows|semgrep/i, 'idefactory init must not copy the sast workflow or installer');
  const templatesRoot = path.join(repoRoot, 'templates');
  const stack = [templatesRoot];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else assert.ok(!full.includes(`${path.sep}workflows${path.sep}`), `template must not include a workflow: ${full}`);
    }
  }

  const steps = runSteps(job);
  const commands = steps.map((step) => step.command);
  assert.ok(
    commands.includes(SEMGREP_COMMAND),
    `sast job must run \`${SEMGREP_COMMAND}\`; found: ${JSON.stringify(commands)}`,
  );
  const semgrepStep = steps.find((step) => step.command === SEMGREP_COMMAND);
  assert.equal(
    semgrepStep.continueOnError,
    false,
    `\`${SEMGREP_COMMAND}\` must fail the job on non-zero exit (no continue-on-error)`,
  );
});

test('Semgrep command fails closed when absent, and --skip-semgrep warns and records the skip', linuxToolRun, () => {
  let trapDir;
  let stubDir;
  let argvPath;
  try {
    // Trap common installers/downloaders: if the command tries to fetch Semgrep, mark failure.
    trapDir = mkdtempSync(path.join(tmpdir(), 'semgrep-trap-'));
    const trapMarker = path.join(trapDir, 'download-attempted');
    const trapBody = `#!/bin/sh\necho trapped > "${trapMarker}"\nexit 1\n`;
    for (const name of ['pip', 'pip3', 'curl', 'wget', 'npm']) {
      writeExecutable(path.join(trapDir, name), trapBody);
    }
    // python3 trap only for pip-install invocations; otherwise allow nothing useful.
    writeExecutable(
      path.join(trapDir, 'python3'),
      `#!/bin/sh\necho trapped > "${trapMarker}"\nexit 1\n`,
    );

    const absent = runSharedSemgrep({ pathDirs: [trapDir] });
    const absentOutput = `${absent.stdout || ''}${absent.stderr || ''}`;
    assert.notEqual(
      absent.status,
      0,
      `absent Semgrep binary must exit non-zero; output:\n${absentOutput}`,
    );
    assert.ok(
      !fs.existsSync(trapMarker),
      'Semgrep command must not download or install anything when the binary is absent',
    );

    const skipped = runSharedSemgrep({ args: ['--skip-semgrep'], pathDirs: [trapDir] });
    const skipOut = skipped.stdout || '';
    const skipErr = skipped.stderr || '';
    const skipCombined = `${skipOut}${skipErr}`;
    assert.equal(
      skipped.status,
      0,
      `--skip-semgrep must exit zero; output:\n${skipCombined}`,
    );
    assert.match(
      skipCombined,
      /semgrep.*skip|skip.*semgrep/i,
      `--skip-semgrep must print a clear warning; output:\n${skipCombined}`,
    );
    assert.match(
      skipOut,
      /^SEMGREP_SKIP$/m,
      `--skip-semgrep must record SEMGREP_SKIP on stdout; stdout:\n${skipOut}`,
    );
    assert.ok(
      !fs.existsSync(trapMarker),
      '--skip-semgrep must not download or install anything',
    );

    // Stub binary records argv; proves the shared command uses the required Semgrep flags.
    stubDir = mkdtempSync(path.join(tmpdir(), 'semgrep-stub-'));
    argvPath = path.join(stubDir, 'argv.json');
    writeExecutable(
      path.join(stubDir, 'semgrep'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvPath}"\nexit 0\n`,
    );
    const stubbed = runSharedSemgrep({ pathDirs: [stubDir, trapDir] });
    const stubOutput = `${stubbed.stdout || ''}${stubbed.stderr || ''}`;
    assert.equal(
      stubbed.status,
      0,
      `stub Semgrep must be invoked successfully; output:\n${stubOutput}`,
    );
    assert.ok(fs.existsSync(argvPath), 'stub Semgrep must have been executed');
    const recordedArgs = fs.readFileSync(argvPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.deepEqual(
      recordedArgs,
      SEMGREP_ARGS,
      `shared command must invoke Semgrep with ${JSON.stringify(SEMGREP_ARGS)}; got ${JSON.stringify(recordedArgs)}`,
    );
  } finally {
    if (trapDir) rmSync(trapDir, { recursive: true, force: true });
    if (stubDir) rmSync(stubDir, { recursive: true, force: true });
  }
});

function readReleaseWorkflow() {
  assert.ok(fs.existsSync(releaseWorkflowPath), `missing ${releaseWorkflowPath}`);
  return fs.readFileSync(releaseWorkflowPath, 'utf8').replace(/\r\n/g, '\n');
}

function releaseJobBlock(yaml) {
  const match = yaml.match(/(?:^|\n)(\s*)release\s*:\s*\n([\s\S]*?)(?=\n\1[A-Za-z0-9_-]+\s*:\s*\n|\n*$)/);
  assert.ok(match, 'release workflow must define a job named release');
  return match[2];
}

function releaseJobSteps(yaml) {
  const job = releaseJobBlock(yaml);
  const steps = [];
  const stepBlocks = job.split(/\n\s*-\s+/).slice(1);
  for (const block of stepBlocks) {
    const usesMatch = block.match(/\buses\s*:\s*(.+)/);
    const runMatch = block.match(/\brun\s*:\s*(?:\|\s*\n([\s\S]*?)(?=\n\s*\w|\n*$)|(.+))/);
    if (usesMatch) {
      const ref = usesMatch[1].replace(/\s+#.*$/, '').trim();
      steps.push({ kind: 'uses', ref, raw: block });
    } else if (runMatch) {
      const body = (runMatch[1] || runMatch[2] || '').trim();
      const command = body.split('\n')[0].trim();
      steps.push({ kind: 'run', command, raw: block });
    }
  }
  return steps;
}

function packageNameFromLockPath(depPath) {
  if (!depPath.startsWith('node_modules/')) return null;
  const withoutPrefix = depPath.slice('node_modules/'.length);
  const nested = withoutPrefix.split('/node_modules/');
  return nested[nested.length - 1];
}

function lockedDependencyIds(lock) {
  const ids = new Set();
  for (const [depPath, meta] of Object.entries(lock.packages ?? {})) {
    if (!meta?.version) continue;
    if (meta.optional) continue;
    const name = meta.name ?? packageNameFromLockPath(depPath);
    if (!name || name === 'ide-factory') continue;
    ids.add(`${name}@${meta.version}`);
  }
  return ids;
}

function componentPackageId(component) {
  if (component.group) {
    return `${component.group}/${component.name}@${component.version}`;
  }
  return `${component.name}@${component.version}`;
}

function sbomProperty(sbom, propertyName) {
  const props = sbom.metadata?.properties ?? [];
  const hit = props.find((entry) => entry.name === propertyName);
  return hit?.value ?? null;
}

function sha256FileHex(filePath) {
  const digest = createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  return `sha256:${digest}`;
}

function gitHeadRevision(cwd = repoRoot) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git rev-parse HEAD failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function runReleaseSbomPipeline({ sourceRevision = gitHeadRevision() } = {}) {
  const releaseDir = path.join(repoRoot, 'release');
  const sbomPath = path.join(releaseDir, 'sbom.cdx.json');
  const binDir = path.join(repoRoot, 'node_modules', '.bin');
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
    SOURCE_REVISION: sourceRevision,
  };
  fs.mkdirSync(releaseDir, { recursive: true });
  try {
    const cyclonedx = spawnSync(CYCLONEDX_COMMAND, {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      shell: true,
    });
    const cyclonedxOutput = `${cyclonedx.stdout || ''}${cyclonedx.stderr || ''}`;
    assert.equal(
      cyclonedx.status,
      0,
      `release SBOM generator must exit zero; output:\n${cyclonedxOutput}`,
    );

    const annotate = spawnSync(ANNOTATE_SBOM_COMMAND, {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      shell: true,
    });
    const annotateOutput = `${annotate.stdout || ''}${annotate.stderr || ''}`;
    assert.equal(
      annotate.status,
      0,
      `SBOM metadata annotation must exit zero; output:\n${annotateOutput}`,
    );

    assert.ok(fs.existsSync(sbomPath), `missing generated SBOM at ${sbomPath}`);
    return JSON.parse(fs.readFileSync(sbomPath, 'utf8'));
  } finally {
    rmSync(releaseDir, { recursive: true, force: true });
  }
}

test('version-tag release workflow generates CycloneDX SBOM with locked deps and metadata; baseline does not publish', () => {
  const baselineYaml = readWorkflow();
  assert.doesNotMatch(
    baselineYaml,
    /\bnpm\s+publish\b/,
    'baseline CI must not publish an npm package',
  );
  assert.doesNotMatch(
    baselineYaml,
    /\bactions\/(upload-release-asset|create-release|softprops\/action-gh-release)\b/,
    'baseline CI must not publish a GitHub release',
  );

  const yaml = readReleaseWorkflow();

  assert.match(
    yaml,
    /^\s*on\s*:/m,
    'release workflow must declare on triggers',
  );
  assert.match(
    yaml,
    /\btags\s*:\s*\n(?:\s+-\s+['"]?v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+['"]?|\s+-\s+['"]?v\*\.\*\.\*['"]?)/m,
    'release workflow must trigger only on semantic version tags (v<major>.<minor>.<patch>)',
  );
  assert.doesNotMatch(
    yaml,
    /\bpull_request\b/,
    'release workflow must not trigger on pull_request',
  );

  assert.match(
    yaml,
    /^\s*contents\s*:\s*read\b/m,
    'release workflow must set permissions.contents to read',
  );
  assert.doesNotMatch(
    yaml,
    /\bnpm\s+publish\b/,
    'release workflow must not publish an npm package',
  );

  const uses = thirdPartyUses(yaml);
  assert.ok(uses.length > 0, 'release workflow must use at least one third-party action');
  for (const ref of uses) {
    const at = ref.lastIndexOf('@');
    assert.ok(at > 0, `action ref must include @pin: ${ref}`);
    const pin = ref.slice(at + 1);
    assert.ok(
      FULL_SHA.test(pin),
      `third-party action must be pinned to a full 40-char commit SHA: ${ref}`,
    );
  }

  assert.match(
    yaml,
    new RegExp(`@cyclonedx/cyclonedx-npm@${CYCLONEDX_NPM_VERSION.replace(/\./g, '\\.')}\\b`),
    `release workflow must pin @cyclonedx/cyclonedx-npm@${CYCLONEDX_NPM_VERSION}`,
  );

  const job = releaseJobBlock(yaml);
  const steps = runSteps(job);
  const commands = steps.map((step) => step.command);
  assert.ok(
    commands.includes(CYCLONEDX_COMMAND),
    `release job must run \`${CYCLONEDX_COMMAND}\`; found: ${JSON.stringify(commands)}`,
  );
  assert.ok(
    commands.includes(ANNOTATE_SBOM_COMMAND),
    `release job must run \`${ANNOTATE_SBOM_COMMAND}\`; found: ${JSON.stringify(commands)}`,
  );
  assert.ok(
    commands.includes('npm ci'),
    `release job must run npm ci before SBOM generation; found: ${JSON.stringify(commands)}`,
  );

  const lock = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
  const expectedIds = lockedDependencyIds(lock);
  assert.ok(expectedIds.size > 0, 'package-lock.json must list locked dependencies');
  assert.ok(
    expectedIds.has('@fission-ai/openspec@1.14.3') || [...expectedIds].some((id) => id.startsWith('@fission-ai/openspec@')),
    'lockfile must include @fission-ai/openspec',
  );

  const sbom = runReleaseSbomPipeline();
  const components = sbom.components ?? [];
  const componentIds = new Set(components.map((component) => componentPackageId(component)));
  const componentNames = new Set(
    components.map((component) => (component.group ? `${component.group}/${component.name}` : component.name)),
  );
  for (const id of expectedIds) {
    const at = id.lastIndexOf('@');
    const packageName = id.slice(0, at);
    const listed = componentIds.has(id)
      || componentNames.has(packageName);
    assert.ok(
      listed,
      `SBOM must list locked dependency ${id}`,
    );
  }

  const openspec = (sbom.components ?? []).find(
    (component) => component.group === '@fission-ai' && component.name === 'openspec',
  );
  assert.ok(openspec, 'SBOM must include @fission-ai/openspec as a component');

  const lockDigest = sha256FileHex(lockfilePath);
  assert.equal(
    sbomProperty(sbom, SBOM_LOCKFILE_PROPERTY),
    lockDigest,
    'SBOM metadata must include the lockfile SHA-256 digest',
  );
  assert.equal(
    sbomProperty(sbom, SBOM_SOURCE_REVISION_PROPERTY),
    gitHeadRevision(),
    'SBOM metadata must include the source revision',
  );
});

test('release workflow attests annotated SBOM with actions/attest-build-provenance and release attestation permissions', () => {
  const yaml = readReleaseWorkflow();

  assert.match(
    yaml,
    /^\s*contents\s*:\s*read\b/m,
    'release workflow must request contents: read',
  );
  assert.match(
    yaml,
    /^\s*id-token\s*:\s*write\b/m,
    'release workflow must request id-token: write for attestation',
  );
  assert.match(
    yaml,
    /^\s*attestations\s*:\s*write\b/m,
    'release workflow must request attestations: write',
  );
  assert.doesNotMatch(
    yaml,
    /^\s*contents\s*:\s*write\b/m,
    'release workflow must not request contents: write',
  );

  assert.doesNotMatch(
    yaml,
    /slsa\.dev\/provenance\/v0\.2/i,
    'release workflow must not claim SLSA provenance v0.2 (Build L2/L3)',
  );
  assert.doesNotMatch(
    yaml,
    /slsa\.github\.io\/spec\/v0\.2/i,
    'release workflow must not claim SLSA spec v0.2 (Build L2/L3)',
  );
  assert.doesNotMatch(
    yaml,
    /\bSLSA\s+Build\s+L[23]\b/i,
    'release workflow must not claim SLSA Build L2 or L3',
  );
  assert.doesNotMatch(
    yaml,
    /\bbuildLevel\s*:\s*[23]\b/,
    'release workflow must not set SLSA buildLevel 2 or 3',
  );

  const steps = releaseJobSteps(yaml);
  const annotateIndex = steps.findIndex(
    (step) => step.kind === 'run' && step.command === ANNOTATE_SBOM_COMMAND,
  );
  assert.ok(annotateIndex >= 0, `release job must run \`${ANNOTATE_SBOM_COMMAND}\``);

  const attestIndex = steps.findIndex(
    (step) => step.kind === 'uses' && step.ref.startsWith('actions/attest-build-provenance@'),
  );
  assert.ok(attestIndex >= 0, 'release job must use actions/attest-build-provenance');
  assert.ok(
    attestIndex > annotateIndex,
    'attest-build-provenance must run after SBOM annotation',
  );

  const attestStep = steps[attestIndex];
  const at = attestStep.ref.lastIndexOf('@');
  const attestPin = attestStep.ref.slice(at + 1);
  assert.ok(
    FULL_SHA.test(attestPin),
    `attest-build-provenance must be pinned to a full commit SHA: ${attestStep.ref}`,
  );
  assert.equal(
    attestPin,
    ATTEST_BUILD_PROVENANCE_SHA,
    `attest-build-provenance must be pinned to ${ATTEST_BUILD_PROVENANCE_SHA}`,
  );

  assert.match(
    attestStep.raw,
    new RegExp(`subject-path\\s*:\\s*${SBOM_SUBJECT_PATH.replace(/\./g, '\\.')}`),
    `attest step must set subject-path to ${SBOM_SUBJECT_PATH}`,
  );
  assert.doesNotMatch(
    attestStep.raw,
    /\bsubject-digest\s*:/,
    'attest step must identify the SBOM via subject-path only',
  );
});

const branchReviewControlsPath = path.join(repoRoot, '.github', 'branch-review-controls.json');
const codeownersPath = path.join(repoRoot, '.github', 'CODEOWNERS');

/** Paths scanned for forbidden forge branch-protection admin API usage. */
const FORGE_ADMIN_SCAN_ROOTS = [
  path.join(repoRoot, '.github'),
  path.join(repoRoot, 'scripts'),
  path.join(repoRoot, 'src'),
];

const FORBIDDEN_FORGE_ADMIN_PATTERNS = [
  /\bgh\s+api\b[^\n]*\brepos\/[^\s]+\/rulesets\b/i,
  /\bgh\s+api\b[^\n]*\brulesets\b/i,
  /api\.github\.com\/repos\/[^/\s]+\/[^/\s]+\/rulesets\b/i,
  /api\.github\.com\/repos\/[^/\s]+\/[^/\s]+\/branches\/[^/\s]+\/protection\b/i,
  /\/repos\/[^/\s]+\/[^/\s]+\/branches\/[^/\s]+\/protection\b/i,
];

function listTextFilesUnder(dir, { extensions } = {}) {
  const hits = [];
  if (!fs.existsSync(dir)) return hits;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      hits.push(...listTextFilesUnder(full, { extensions }));
      continue;
    }
    if (!entry.isFile()) continue;
    if (extensions && !extensions.some((ext) => entry.name.endsWith(ext))) continue;
    hits.push(full);
  }
  return hits;
}

test('branch-review-controls declaration, CODEOWNERS, and no forge admin API in implementation', () => {
  assert.ok(
    fs.existsSync(branchReviewControlsPath),
    `missing ${branchReviewControlsPath}`,
  );
  const declaration = JSON.parse(fs.readFileSync(branchReviewControlsPath, 'utf8'));
  assert.equal(declaration.schemaVersion, 1, 'branch-review-controls schemaVersion must be 1');
  assert.equal(
    declaration.requiredStatusCheckName,
    'baseline',
    'required status check name must match baseline job',
  );
  assert.equal(declaration.requiredApprovingReviewCount, 1, 'must require one approving review');
  assert.equal(declaration.allowForcePushes, false, 'force-push must be disabled');
  assert.equal(declaration.protectedBranch, 'main', 'protected branch must be main');
  assert.equal(
    declaration.enforcedByForge,
    false,
    'declaration must not claim forge enforcement until a human enables it',
  );

  assert.ok(fs.existsSync(codeownersPath), `missing ${codeownersPath}`);
  const codeowners = fs.readFileSync(codeownersPath, 'utf8');
  assert.match(
    codeowners,
    /^\*\s+@jdanley-bib\s*$/m,
    'CODEOWNERS must assign all paths to @jdanley-bib',
  );

  const scanExtensions = ['.mjs', '.js', '.yml', '.yaml', '.sh', '.json'];
  const scanned = [];
  for (const root of FORGE_ADMIN_SCAN_ROOTS) {
    scanned.push(...listTextFilesUnder(root, { extensions: scanExtensions }));
  }
  for (const filePath of scanned) {
    if (path.basename(filePath) === 'branch-review-controls.json') continue;
    const body = fs.readFileSync(filePath, 'utf8');
    for (const pattern of FORBIDDEN_FORGE_ADMIN_PATTERNS) {
      assert.doesNotMatch(
        body,
        pattern,
        `implementation must not call forge admin APIs to change branch protection (${path.relative(repoRoot, filePath)})`,
      );
    }
  }
});

/** Task 5.1 integration commands in execution order (npm test and validate --all each run twice). */
const TASK_5_1_COMMAND_RUNS = [
  'npx openspec validate establish-factory-ci-and-provenance --strict',
  'npx openspec validate --all',
  'npm test',
  'npm ci',
  'npm test',
  'npm audit --audit-level=high',
  'npx openspec validate --all',
];

function parseImplementationNoteSections(notes) {
  const sections = [];
  const lines = notes.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const header = lines[i].match(/^### `(.+)`$/);
    if (header) {
      const command = header[1];
      i += 1;
      const bodyLines = [];
      while (i < lines.length && !lines[i].startsWith('### ')) {
        bodyLines.push(lines[i]);
        i += 1;
      }
      sections.push({ command, body: bodyLines.join('\n') });
      continue;
    }
    i += 1;
  }
  return sections;
}

function recordedExitCode(sectionBody) {
  const match = sectionBody.match(/- Exit code: `(\d+)`/);
  return match ? Number(match[1]) : null;
}

function isRealExitCode(code) {
  return Number.isInteger(code) && code >= 0 && code <= 255;
}

/** Set while a parent `npm test` run is verifying recorded exits (prevents nested honesty loops). */
const TASK_51_NPM_TEST_GUARD = 'IDE_FACTORY_CI_PROVENANCE_51_OBSERVED';

function observedExitCode(command) {
  const result = spawnSync(command, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: true,
    stdio: 'pipe',
    env: {
      ...process.env,
      ...(command === 'npm test' ? { [TASK_51_NPM_TEST_GUARD]: '1' } : {}),
    },
  });
  return result.status ?? 1;
}

function isArchivedChangeValidate(command) {
  const match = command.match(/^npx openspec validate (\S+)(?: --strict)?$/);
  if (!match || match[1].startsWith('--')) return false;
  const name = match[1];
  if (fs.existsSync(path.join(repoRoot, 'openspec', 'changes', name))) return false;
  const archive = path.join(repoRoot, 'openspec', 'changes', 'archive');
  if (!fs.existsSync(archive)) return false;
  return fs.readdirSync(archive).some((entry) => entry === name || entry.endsWith(`-${name}`));
}

test('implementation notes record task 5.1 integration commands with honest exit codes', () => {
  const notesPath = path.join(
    repoRoot,
    'openspec/changes/archive/2026-10-22-establish-factory-ci-and-provenance/implementation-notes.md',
  );
  assert.ok(fs.existsSync(notesPath), `missing implementation notes: ${notesPath}`);
  const notes = fs.readFileSync(notesPath, 'utf8');
  const sections = parseImplementationNoteSections(notes);
  assert.equal(
    sections.length,
    TASK_5_1_COMMAND_RUNS.length,
    `implementation notes must have ${TASK_5_1_COMMAND_RUNS.length} command sections; found ${sections.length}`,
  );
  const nestedNpmTestRun = process.env[TASK_51_NPM_TEST_GUARD] === '1';
  const inNpmTestLifecycle = process.env.npm_lifecycle_event === 'test';
  let npmTestObserved;
  for (let index = 0; index < TASK_5_1_COMMAND_RUNS.length; index += 1) {
    const expectedCommand = TASK_5_1_COMMAND_RUNS[index];
    const section = sections[index];
    assert.equal(
      section.command,
      expectedCommand,
      `section ${index + 1} must record \`${expectedCommand}\`; got \`${section.command}\``,
    );
    const recorded = recordedExitCode(section.body);
    assert.ok(
      isRealExitCode(recorded),
      `section ${index + 1} (\`${expectedCommand}\`) must record a real exit code 0–255`,
    );
    if (inNpmTestLifecycle) {
      continue;
    }
    // Openspec validates active changes only. After archive, the historical
    // command name is unknown, so a live re-run cannot reproduce the original exit.
    if (isArchivedChangeValidate(expectedCommand)) {
      continue;
    }
    if (nestedNpmTestRun && expectedCommand === 'npm test') {
      continue;
    }
    let observed;
    if (expectedCommand === 'npm test') {
      if (npmTestObserved === undefined) {
        npmTestObserved = observedExitCode(expectedCommand);
      }
      observed = npmTestObserved;
    } else {
      observed = observedExitCode(expectedCommand);
    }
    assert.equal(
      recorded,
      observed,
      `section ${index + 1} (\`${expectedCommand}\`) recorded exit ${recorded} but re-run exited ${observed}`,
    );
  }
});
