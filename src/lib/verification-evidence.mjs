import { spawn, spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attemptPath, getAttempt } from './attempt.mjs';
import { appendControlEvent } from './event-log.mjs';
import { classifyCheckOutcome, retryKey } from './red-evidence.mjs';
import { closeLatestRunSession } from './run-session.mjs';
import { halted, writeText } from './layout.mjs';

const SUPPORTED_SCHEMA_VERSION = 1;
const ALLOWED_CWD_POLICY = 'project';
const RUNNER_NAME = 'idefactory';

const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json'),
    'utf8',
  ),
).version;

/**
 * Hash of canonical argv JSON: lowercase sha256: hex.
 */
export function commandDigest(argv) {
  const canonical = JSON.stringify(argv);
  const hex = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `sha256:${hex}`;
}

/** Security-patterned check kinds (threat-review, sast, secret, audit, …). */
export function isSecurityPatternedCheck(check) {
  return /security|sast|threat|secret|audit/i.test(String(check));
}

/**
 * Canonical JSON for attestation signatures: UTF-8, recursively sorted object
 * keys, no insignificant whitespace. Arrays keep order. Strings and numbers
 * use JSON.stringify. The signature field must be omitted by the caller.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function digestBytes(bytes) {
  const hex = createHash('sha256').update(bytes).digest('hex');
  return `sha256:${hex}`;
}

/**
 * Validate a stored check evidence record. Rejects a record with no exitCode.
 *
 * @param {object} record
 */
export function validateCheckRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('check record must be an object');
  }
  if (record.exitCode === undefined || record.exitCode === null) {
    throw new Error('check record requires exitCode');
  }
}

/**
 * Validate a versioned check registry. Rejects unsupported schema versions,
 * shell command strings, empty argv, non-project cwd policy, non-positive
 * timeouts, and artifact paths that escape the project root.
 *
 * @param {object} registry
 * @param {{ projectRoot: string }} options
 * @returns {{ schemaVersion: number, checks: Record<string, object> }}
 */
export function validateCheckRegistry(registry, options = {}) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    throw new Error('check registry must be an object');
  }
  if (registry.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(`unsupported check registry schema version: ${registry.schemaVersion}`);
  }

  const projectRoot = options.projectRoot;
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw new Error('projectRoot is required to validate check registry paths');
  }
  const resolvedRoot = path.resolve(projectRoot);

  const checksIn = registry.checks;
  if (!checksIn || typeof checksIn !== 'object' || Array.isArray(checksIn)) {
    throw new Error('check registry must include a checks object');
  }

  const checks = {};
  for (const [kind, entry] of Object.entries(checksIn)) {
    checks[kind] = validateCheckEntry(kind, entry, resolvedRoot);
  }

  return { schemaVersion: SUPPORTED_SCHEMA_VERSION, checks };
}

function validateCheckEntry(kind, entry, projectRoot) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`check "${kind}" must be an object`);
  }

  if (typeof entry.command === 'string') {
    throw new Error(`check "${kind}" rejects shell command string; use argv array`);
  }

  const { argv } = entry;
  if (typeof argv === 'string') {
    throw new Error(`check "${kind}" rejects shell command string; argv must be a string array`);
  }
  if (!Array.isArray(argv)) {
    throw new Error(`check "${kind}" requires a non-empty argv string array`);
  }
  if (argv.length === 0) {
    throw new Error(`check "${kind}" rejects empty argv`);
  }
  if (!argv.every((part) => typeof part === 'string' && part.length > 0)) {
    throw new Error(`check "${kind}" argv entries must be non-empty strings`);
  }

  if (entry.cwdPolicy !== ALLOWED_CWD_POLICY) {
    throw new Error(`check "${kind}" cwdPolicy must be "${ALLOWED_CWD_POLICY}"`);
  }

  const timeoutMs = entry.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`check "${kind}" timeoutMs must be a positive integer`);
  }

  if (!Array.isArray(entry.artifacts)) {
    throw new Error(`check "${kind}" artifacts must be an array`);
  }
  const artifacts = entry.artifacts.map((artifact) =>
    validateArtifactPath(kind, artifact, projectRoot));

  return {
    argv: [...argv],
    cwdPolicy: ALLOWED_CWD_POLICY,
    timeoutMs,
    artifacts,
    commandDigest: commandDigest(argv),
  };
}

/**
 * Run a registered check and store derived evidence on the attempt.
 * `passed` is always derived from exitCode, timedOut, and artifact presence.
 * Caller-supplied `red` objects are ignored. `--red` stores an assertion
 * failure at evidence.reds[kind] and does not write evidence.red.
 *
 * @param {string} project
 * @param {string} attemptId
 * @param {{ check: string, asRed?: boolean, red?: unknown }} options
 */
export async function verifyRun(project, attemptId, options = {}) {
  if (halted(project)) {
    throw new Error('HALT file present. Factory commands are stopped. Remove it with idefactory resume.');
  }
  const kind = options.check;
  if (!kind || typeof kind !== 'string') {
    throw new Error('verify run requires --check <kind>');
  }
  const asRed = Boolean(options.asRed);
  // Caller-supplied red payloads are intentionally ignored.

  const attempt = getAttempt(project, attemptId);
  if (!attempt) throw new Error(`Attempt not found: ${attemptId}`);

  const registryPath = path.join(project, '.factory', 'checks.json');
  if (!fs.existsSync(registryPath)) {
    throw new Error('missing check registry: .factory/checks.json');
  }
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const validated = validateCheckRegistry(registry, { projectRoot: project });
  const entry = validated.checks[kind];
  if (!entry) throw new Error(`Unknown check kind: ${kind}`);

  const startedAt = new Date().toISOString();
  const { exitCode, timedOut, stdout, stderr, spawnError } = await spawnCheck(entry.argv, {
    cwd: project,
    timeoutMs: entry.timeoutMs,
  });
  if (spawnError && !asRed) throw spawnError;
  const finishedAt = new Date().toISOString();
  const output = Buffer.concat([stdout, stderr]).toString('utf8');
  const classification = classifyCheckOutcome({
    spawnError,
    timedOut,
    exitCode,
    output,
    asRed,
  });

  if (asRed && classification !== 'assertion-failure') {
    const count = noteRetry(attempt, classification, kind);
    writeText(attemptPath(project, attemptId), JSON.stringify(attempt, null, 2));
    if (count >= 4) {
      closeLatestRunSession(project, attempt.change, 'retry-cap');
      throw new Error(`retry-cap: ${classification} for ${kind}`);
    }
    if (classification === 'vacuous-red') {
      closeLatestRunSession(project, attempt.change, 'vacuous-red');
    }
    throw new Error(`${classification}: red run did not record an assertion failure for ${kind}`);
  }

  const logDigest = digestBytes(Buffer.concat([stdout, stderr]));
  const { artifactDigests, allPresent } = hashArtifacts(project, entry.artifacts);
  const { sourceRevision, worktreeClean } = resolveGitBinding(project);

  const passed = exitCode === 0
    && !timedOut
    && allPresent
    && worktreeClean
    && sourceRevision !== undefined;
  const record = {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    kind,
    runner: { name: RUNNER_NAME, version: PACKAGE_VERSION },
    argv: [...entry.argv],
    commandDigest: entry.commandDigest,
    exitCode,
    startedAt,
    finishedAt,
    logDigest,
    artifactDigests,
    attemptId,
    passed,
    issuer: 'cli',
    timedOut,
    worktreeClean,
  };
  if (sourceRevision !== undefined) {
    record.sourceRevision = sourceRevision;
  }

  validateCheckRecord(record);

  if (asRed) {
    attempt.evidence.reds = { ...(attempt.evidence.reds || {}), [kind]: record };
  } else if (isSecurityPatternedCheck(kind)) {
    attempt.evidence.security = [...(attempt.evidence.security || []), record];
  } else {
    attempt.evidence.verification = [...(attempt.evidence.verification || []), record];
  }

  attempt.updatedAt = new Date().toISOString();
  writeText(attemptPath(project, attemptId), JSON.stringify(attempt, null, 2));
  appendControlEvent(project, {
    type: 'verification.recorded',
    time: finishedAt,
    attemptId,
    commandDigest: record.commandDigest,
    exitCode: record.exitCode,
  });
  return { attempt, record };
}

/**
 * Import a signature-valid attestation onto an attempt. Fail closed when
 * importKeys are missing, the key id is unknown, the signature is invalid,
 * attemptId/commandDigest/sourceRevision do not bind, or the worktree is dirty.
 * Never writes evidence.red. `passed` is derived from exitCode === 0.
 *
 * @param {string} project
 * @param {string} attemptId
 * @param {{ file: string }} options
 */
export async function verifyImport(project, attemptId, options = {}) {
  if (halted(project)) {
    throw new Error('HALT file present. Factory commands are stopped. Remove it with idefactory resume.');
  }
  const filePath = options.file;
  if (!filePath || typeof filePath !== 'string' || filePath === true) {
    throw new Error('verify import requires --file <path>');
  }

  const attempt = getAttempt(project, attemptId);
  if (!attempt) throw new Error(`Attempt not found: ${attemptId}`);

  const registryPath = path.join(project, '.factory', 'checks.json');
  if (!fs.existsSync(registryPath)) {
    throw new Error('missing check registry: .factory/checks.json');
  }
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const validated = validateCheckRegistry(registry, { projectRoot: project });

  const importKeys = registry.importKeys;
  if (!Array.isArray(importKeys) || importKeys.length === 0) {
    throw new Error('importKeys missing from check registry');
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`attestation file not found: ${filePath}`);
  }
  const attestation = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
    throw new Error('attestation must be an object');
  }

  const keyId = attestation.keyId;
  if (!keyId || typeof keyId !== 'string') {
    throw new Error('attestation requires keyId');
  }
  const keyEntry = importKeys.find((entry) => entry && entry.id === keyId);
  if (!keyEntry || typeof keyEntry.publicKeyPem !== 'string') {
    throw new Error(`unknown import key id: ${keyId}`);
  }

  const signature = attestation.signature;
  if (!signature || typeof signature !== 'string') {
    throw new Error('attestation requires base64 signature');
  }

  const signedPayload = { ...attestation };
  delete signedPayload.signature;
  const data = Buffer.from(canonicalJson(signedPayload), 'utf8');
  const signatureBytes = Buffer.from(signature, 'base64');
  let publicKey;
  try {
    publicKey = createPublicKey(keyEntry.publicKeyPem);
  } catch {
    throw new Error(`invalid import public key for id: ${keyId}`);
  }
  const signatureValid = verify(null, data, publicKey, signatureBytes);
  if (!signatureValid) {
    throw new Error('invalid attestation signature');
  }

  if (attestation.attemptId !== attemptId) {
    throw new Error(`attestation attemptId does not match target attempt: ${attemptId}`);
  }

  const kind = attestation.kind;
  if (!kind || typeof kind !== 'string') {
    throw new Error('attestation requires kind');
  }
  const entry = validated.checks[kind];
  if (!entry) throw new Error(`Unknown check kind: ${kind}`);
  if (attestation.commandDigest !== entry.commandDigest) {
    throw new Error('attestation commandDigest does not match registry argv');
  }

  const { sourceRevision, worktreeClean } = resolveGitBinding(project);
  if (!worktreeClean) {
    throw new Error('import rejected: worktree is dirty');
  }
  if (sourceRevision === undefined) {
    throw new Error('import rejected: git HEAD is unresolvable');
  }
  if (attestation.sourceRevision !== sourceRevision) {
    throw new Error('attestation sourceRevision does not match current clean HEAD');
  }

  if (attestation.exitCode === undefined || attestation.exitCode === null) {
    throw new Error('attestation requires exitCode');
  }

  const passed = attestation.exitCode === 0;
  const record = {
    schemaVersion: attestation.schemaVersion ?? SUPPORTED_SCHEMA_VERSION,
    kind,
    runner: attestation.runner,
    argv: Array.isArray(attestation.argv) ? [...attestation.argv] : [...entry.argv],
    commandDigest: entry.commandDigest,
    cwdPolicy: attestation.cwdPolicy ?? 'project',
    exitCode: attestation.exitCode,
    timedOut: Boolean(attestation.timedOut),
    startedAt: attestation.startedAt,
    finishedAt: attestation.finishedAt,
    sourceRevision,
    worktreeClean: true,
    logDigest: attestation.logDigest,
    artifactDigests: Array.isArray(attestation.artifactDigests)
      ? attestation.artifactDigests
      : [],
    attemptId,
    passed,
    issuer: 'import',
  };
  if (attestation.id !== undefined) {
    record.id = attestation.id;
  }

  validateCheckRecord(record);

  attempt.evidence.verification = [...(attempt.evidence.verification || []), record];
  // Import never writes evidence.red.

  attempt.updatedAt = new Date().toISOString();
  writeText(attemptPath(project, attemptId), JSON.stringify(attempt, null, 2));
  appendControlEvent(project, {
    type: 'verification.recorded',
    time: record.finishedAt,
    attemptId,
    commandDigest: record.commandDigest,
    exitCode: record.exitCode,
  });
  return { attempt, record };
}

function noteRetry(attempt, classification, kind) {
  if (classification !== 'infrastructure-failure' && classification !== 'vacuous-red') return 0;
  const key = retryKey(classification, kind);
  const counts = { ...(attempt.evidence.retryCounts || {}) };
  counts[key] = (counts[key] || 0) + 1;
  attempt.evidence.retryCounts = counts;
  attempt.updatedAt = new Date().toISOString();
  return counts[key];
}

function spawnCheck(argv, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(chunk);
    });

    let timedOut = false;
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (error) => {
      finish({
        exitCode: null,
        timedOut,
        spawnError: error,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
      });
    });
    child.on('close', (code) => {
      finish({
        exitCode: typeof code === 'number' ? code : 1,
        timedOut,
        spawnError: null,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
      });
    });
  });
}

function hashArtifacts(projectRoot, artifacts) {
  const artifactDigests = [];
  let allPresent = true;
  for (const artifact of artifacts) {
    const fullPath = path.resolve(projectRoot, artifact);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      allPresent = false;
      continue;
    }
    const bytes = fs.readFileSync(fullPath);
    artifactDigests.push({ path: artifact, digest: digestBytes(bytes) });
  }
  return { artifactDigests, allPresent };
}

/**
 * Factory run-state paths that verify/complete mutate. Dirt here must not
 * block a source-revision pass; source, tests, OpenSpec, and checks.json still do.
 */
const FACTORY_RUN_STATE_PREFIXES = [
  '.factory/attempts/',
  '.factory/work/',
  '.factory/orchestration/',
  '.factory/observability/',
  '.factory/approvals/',
];
const FACTORY_RUN_STATE_FILES = new Set([
  '.factory/ledger.jsonl',
  '.factory/active-change.json',
  '.factory/decisions.md',
]);

function normalizeGitPath(relPath) {
  return String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function unquoteGitPath(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\([\\"ntr])/g, (_, ch) => {
      if (ch === 'n') return '\n';
      if (ch === 't') return '\t';
      if (ch === 'r') return '\r';
      return ch;
    });
  }
  return trimmed;
}

function porcelainPaths(line) {
  if (!line || line.length < 3) return [];
  const rest = line.slice(3);
  if (rest.includes(' -> ')) {
    return rest.split(' -> ').map(unquoteGitPath).map(normalizeGitPath);
  }
  return [normalizeGitPath(unquoteGitPath(rest))];
}

const AGENT_HISTORY_RUN_STATE = /^\.factory\/agents\/[^/]+\/history\.md$/;
const AGENT_ROLE_DIR_RUN_STATE = /^\.factory\/agents\/([^/]+)\/?$/;

function isHistoryOnlyRoleDirectory(projectCwd, relPath) {
  const normalized = normalizeGitPath(relPath);
  const match = AGENT_ROLE_DIR_RUN_STATE.exec(normalized);
  if (!match) return false;
  const role = match[1];
  if (!role || role === '.' || role === '..') return false;

  const roleDir = path.join(projectCwd, '.factory', 'agents', role);
  let entries;
  try {
    entries = fs.readdirSync(roleDir, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.length !== 1) return false;
  const [only] = entries;
  return only.isFile() && only.name === 'history.md';
}

function isFactoryRunStatePath(relPath, projectCwd) {
  const normalized = normalizeGitPath(relPath);
  if (FACTORY_RUN_STATE_FILES.has(normalized)) return true;
  if (AGENT_HISTORY_RUN_STATE.test(normalized)) return true;
  if (isHistoryOnlyRoleDirectory(projectCwd, normalized)) return true;
  return FACTORY_RUN_STATE_PREFIXES.some(
    (prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix),
  );
}

/**
 * Resolve HEAD and worktree cleanliness for source-revision binding.
 * A pass requires a resolvable HEAD and no dirty non-run-state paths.
 */
export function resolveGitBinding(cwd) {
  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    shell: false,
  });
  if (headResult.status !== 0) {
    return { sourceRevision: undefined, worktreeClean: false };
  }
  const sha = (headResult.stdout || '').trim();
  if (!sha) {
    return { sourceRevision: undefined, worktreeClean: false };
  }

  const statusResult = spawnSync('git', ['status', '--porcelain'], {
    cwd,
    encoding: 'utf8',
    shell: false,
  });
  if (statusResult.status !== 0) {
    return { sourceRevision: sha, worktreeClean: false };
  }
  const lines = (statusResult.stdout || '').split('\n').filter((line) => line.length > 0);
  const worktreeClean = lines.every((line) => {
    const paths = porcelainPaths(line);
    return paths.length > 0 && paths.every((p) => isFactoryRunStatePath(p, cwd));
  });
  return { sourceRevision: sha, worktreeClean };
}

function validateArtifactPath(kind, artifact, projectRoot) {
  if (typeof artifact !== 'string' || artifact.length === 0) {
    throw new Error(`check "${kind}" artifact paths must be non-empty strings`);
  }
  if (artifact.includes('\0')) {
    throw new Error(`check "${kind}" artifact path is invalid`);
  }

  const segments = artifact.split(/[/\\]/).filter((part) => part.length > 0);
  if (segments.some((part) => part === '..')) {
    throw new Error(`check "${kind}" artifact path rejects parent-directory segments: ${artifact}`);
  }

  const resolved = path.isAbsolute(artifact)
    ? path.resolve(artifact)
    : path.resolve(projectRoot, artifact);
  const relative = path.relative(projectRoot, resolved);
  if (
    relative === ''
    || relative.startsWith(`..${path.sep}`)
    || relative === '..'
    || path.isAbsolute(relative)
  ) {
    throw new Error(`check "${kind}" artifact path is outside the project: ${artifact}`);
  }

  return artifact;
}
