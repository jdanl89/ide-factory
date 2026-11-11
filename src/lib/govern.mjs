import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROLES, ledger, readText, writeText } from './layout.mjs';
import { appendControlEvent } from './event-log.mjs';
import { confirmPrincipal, configuredPrincipalProvider, readPolicyVersion } from './principal.mjs';
import { setupReadinessErrors } from './setup.mjs';
import { writeScopedApproval } from './risk-gates.mjs';
import { resolveGitBinding } from './verification-evidence.mjs';
import { listWorkItems, workCounts } from './work.mjs';

const REQUIRED = [
  '.factory/team.md',
  '.factory/routing.md',
  '.factory/decisions.md',
  '.factory/config.json',
  '.factory/governance.md',
  '.factory/profiles.json',
  '.factory/work/index.json',
  '.cursor/rules/factory.mdc',
  '.cursor/skills/factory-coordinator/SKILL.md',
  '.cursor/skills/factory-run/SKILL.md',
  '.github/agents/factory.agent.md',
  '.github/skills/factory-coordinator/SKILL.md',
  '.claude/skills/factory-coordinator/SKILL.md',
  '.cline/rules/factory.md',
  '.cline/skills/factory-coordinator/SKILL.md',
  ...ROLES.flatMap((role) => [
    `.factory/agents/${role}/charter.md`,
    `.factory/agents/${role}/history.md`,
  ]),
];

export function doctor(project) {
  const errors = [];
  const warnings = [];
  for (const rel of REQUIRED) {
    if (!fs.existsSync(path.join(project, rel))) errors.push(`missing ${rel}`);
  }
  const configPath = path.join(project, '.factory', 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(readText(configPath));
      if (config.runtime !== 'ide') errors.push('config.json runtime must be "ide"');
      if (config.ideation !== false) errors.push('config.json ideation must be false');
    } catch {
      errors.push('config.json is not valid JSON');
    }
  }
  if (!fs.existsSync(path.join(project, 'openspec'))) warnings.push('openspec/ is not initialized');
  if (fs.existsSync(path.join(project, 'HALT'))) warnings.push('HALT file is present');
  const policyVersion = readPolicyVersion(project);
  for (const item of setupReadinessErrors(project)) errors.push(item);
  for (const kind of unmappedCheckKinds(project)) {
    warnings.push(`unmapped check kind: ${kind}`);
  }
  return { errors, warnings, policyVersion };
}

export function status(project, _env) {
  const halt = fs.existsSync(path.join(project, 'HALT'));
  const active = readJson(path.join(project, '.factory', 'active-change.json'));
  const team = fs.existsSync(path.join(project, '.factory', 'team.md'))
    ? readText(path.join(project, '.factory', 'team.md')).trim()
    : '(not installed)';
  const now = fs.existsSync(path.join(project, '.factory', 'identity', 'now.md'))
    ? readText(path.join(project, '.factory', 'identity', 'now.md')).trim()
    : '(none)';
  const changes = listChanges(project);
  const change = active?.change || '';
  const counts = workCounts(project, change || undefined);
  const workLine = change
    ? `${counts.todo} todo, ${counts.in_progress} in progress, ${counts.done} done, ${counts.blocked} blocked`
    : summarizeAllWork(project);
  return [
    'Factory status',
    `HALT: ${halt ? 'yes' : 'no'}`,
    `Active change: ${active?.change || '(none)'}`,
    `OpenSpec changes: ${changes.join(', ') || '(none)'}`,
    `Work queue: ${workLine}`,
    '',
    team,
    '',
    now,
    '',
  ].join('\n');
}

function summarizeAllWork(project) {
  const items = listWorkItems(project);
  if (!items.length) return 'empty';
  const counts = { todo: 0, in_progress: 0, done: 0, blocked: 0 };
  for (const item of items) {
    if (counts[item.status] !== undefined) counts[item.status] += 1;
  }
  return `${counts.todo} todo, ${counts.in_progress} in progress, ${counts.done} done, ${counts.blocked} blocked`;
}

/**
 * Issue a scoped approval JSON token and append its id to decisions.md.
 * Missing caller scope, validation failure, or a dirty non-run-state tree
 * writes nothing (no approval file, no decisions line).
 *
 * @param {string} project
 * @param {string} id
 * @param {string} note
 * @param {{ change?: string, task?: string, action?: string, approver?: string, expiry?: string }} [scope]
 * @returns {string} path written
 */
export function approve(project, id, note, scope = {}) {
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id)) {
    throw new Error('Usage: idefactory approve <id> --note "..." --change ... --task ... --action ... --approver ... --expiry ...');
  }
  if (!note) throw new Error('--note is required');
  const decisions = path.join(project, '.factory', 'decisions.md');
  if (!fs.existsSync(decisions)) throw new Error('No .factory/decisions.md. Run idefactory init first.');

  const { sourceRevision, worktreeClean } = resolveGitBinding(project);
  if (!worktreeClean || !sourceRevision) {
    throw new Error('approval requires a clean worktree and resolvable HEAD (factory run-state dirt ignored)');
  }

  const issuance = new Date().toISOString();
  const policyVersion = readPolicyVersion(project);
  let principal;
  if (policyVersion >= 2) {
    principal = confirmPrincipal(project, {
      provider: scope.principalProvider,
      subject: scope.principalSubject,
    });
    if (scope.approver !== principal.subject) {
      throw new Error('approval approver must equal the verified principal subject');
    }
  }
  const record = {
    schemaVersion: principal ? 2 : 1,
    change: scope.change,
    task: scope.task,
    sourceRevision,
    action: scope.action,
    approver: scope.approver,
    issuance,
    expiry: scope.expiry,
    policyVersion,
    note,
    ...(principal ? { principal } : {}),
  };

  let file;
  try {
    file = writeScopedApproval(project, id, record);
  } catch (error) {
    // Validator / write failure must leave decisions.md untouched.
    throw error;
  }

  const stamp = stampNow();
  const entry = `\n## ${stamp.slice(0, 10)} accepted ${id}\n\nStatus: accepted\nId: ${id}\nNote: ${note}\n`;
  fs.appendFileSync(decisions, entry.endsWith('\n') ? entry : `${entry}\n`);
  ledger(project, 'accepted', { id });
  appendControlEvent(project, {
    type: 'approval.issued',
    time: issuance,
    id,
    change: scope.change,
    task: scope.task,
  });
  return file;
}

function unmappedCheckKinds(project) {
  const profilesPath = path.join(project, '.factory', 'profiles.json');
  const registryPath = path.join(project, '.factory', 'checks.json');
  if (!fs.existsSync(profilesPath) || !fs.existsSync(registryPath)) return [];
  let profiles;
  let registry;
  try {
    profiles = JSON.parse(readText(profilesPath));
    registry = JSON.parse(readText(registryPath));
  } catch {
    return [];
  }
  const mapped = new Set(Object.keys(registry?.checks || {}));
  const missing = new Set();
  for (const profile of Object.values(profiles || {})) {
    if (!profile || !Array.isArray(profile.checks)) continue;
    for (const kind of profile.checks) {
      if (typeof kind === 'string' && !mapped.has(kind)) missing.add(kind);
    }
  }
  return [...missing].sort();
}

export function reject(project, id, note) {
  return recordDecision(project, id, note, 'rejected');
}

/**
 * Create an immutable schema version 1 lockout event directory.
 * `idefactory lockout --agent ...` is an alias for this create path.
 *
 * @returns {{ id: string, createdPath: string }}
 */
export function createLockout(project, { agent, reviewer, reason }) {
  if (!agent || !/^[a-z0-9-]+$/.test(agent)) {
    throw new Error('Usage: idefactory lockout create --agent <id> --reason "..."');
  }
  if (!reason) throw new Error('lockout requires --reason');
  const who = reviewer || 'reviewer';
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const createdPath = lockoutCreatedPath(project, id);
  const record = {
    schemaVersion: 1,
    id,
    agent,
    reviewer: who,
    reason,
    createdAt,
  };
  writeJsonExclusive(createdPath, record);
  ledger(project, 'lockout', { agent, reviewer: who, id });
  appendControlEvent(project, {
    type: 'lockout.created',
    time: createdAt,
    id,
    agent,
  });
  return { id, createdPath };
}

/** Compatibility alias for createLockout (CLI `lockout --agent ...`). */
export function lockout(project, options) {
  return createLockout(project, options);
}

/**
 * Resolve a versioned lockout id or a legacy `*lockout*.md` basename.
 * Exact repeats succeed without rewriting; conflicting inputs fail closed.
 *
 * @returns {{ id: string, resolvedPath: string }}
 */
export function resolveLockout(project, id, { resolver, reason }) {
  if (!id || typeof id !== 'string') {
    throw new Error('Usage: idefactory lockout resolve <id> --resolver <id> --reason "..."');
  }
  if (!resolver || !/^[a-z0-9-]+$/.test(resolver)) {
    throw new Error('lockout resolve requires --resolver <id>');
  }
  if (!reason) throw new Error('lockout resolve requires --reason');

  const legacy = findLegacyLockout(project, id);
  if (legacy) {
    return resolveLegacyLockout(project, legacy, { resolver, reason });
  }

  const createdPath = lockoutCreatedPath(project, id);
  if (!fs.existsSync(createdPath)) {
    throw new Error(`Lockout not found: ${id}`);
  }
  const created = readJsonFile(createdPath);
  if (!isValidCreatedRecord(created) || created.id !== id) {
    throw new Error(`Lockout creation record is invalid: ${id}`);
  }
  if (resolver === created.agent) {
    throw new Error('lockout resolver must be distinct from the locked agent');
  }
  if (readPolicyVersion(project) >= 2) {
    confirmPrincipal(project, {
      provider: configuredPrincipalProvider(project),
      subject: resolver,
    });
  }

  const resolvedPath = lockoutResolvedPath(project, id);
  const resolution = {
    schemaVersion: 1,
    resolver,
    reason,
    resolvedAt: new Date().toISOString(),
  };
  return writeOrMatchResolution(project, id, resolvedPath, resolution);
}

/**
 * True when an unresolved versioned lockout or unresolved legacy markdown note
 * is present under `.factory/orchestration/`.
 */
export function hasActiveLockout(project) {
  const orch = path.join(project, '.factory', 'orchestration');
  if (!fs.existsSync(orch)) return false;

  const lockoutsDir = path.join(orch, 'lockouts');
  if (fs.existsSync(lockoutsDir)) {
    for (const entry of fs.readdirSync(lockoutsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const createdPath = path.join(lockoutsDir, entry.name, 'created.json');
      if (!fs.existsSync(createdPath)) continue;
      const created = readJsonFile(createdPath);
      if (!isValidCreatedRecord(created)) return true;
      if (created.legacyPath) continue; // legacy activity decided from the markdown + matching events
      const resolvedPath = path.join(lockoutsDir, entry.name, 'resolved.json');
      if (!fs.existsSync(resolvedPath) || !isValidResolvedRecord(readJsonFile(resolvedPath))) {
        return true;
      }
    }
  }

  for (const name of fs.readdirSync(orch)) {
    if (!name.includes('lockout') || !name.endsWith('.md')) continue;
    if (!legacyLockoutResolved(project, name)) return true;
  }
  return false;
}

function resolveLegacyLockout(project, legacy, { resolver, reason }) {
  const { basename, absPath, relPath, body, digest, agent } = legacy;
  if (resolver === agent) {
    throw new Error('lockout resolver must be distinct from the locked agent');
  }
  if (readPolicyVersion(project) >= 2) {
    confirmPrincipal(project, {
      provider: configuredPrincipalProvider(project),
      subject: resolver,
    });
  }

  const createdPath = lockoutCreatedPath(project, basename);
  if (!fs.existsSync(createdPath)) {
    const created = {
      schemaVersion: 1,
      id: basename,
      agent,
      reviewer: legacy.reviewer,
      reason: legacy.reason,
      createdAt: new Date().toISOString(),
      legacyPath: relPath,
      legacyDigest: digest,
    };
    writeJsonExclusive(createdPath, created);
  } else {
    const existing = readJsonFile(createdPath);
    if (!isValidCreatedRecord(existing)
      || existing.legacyPath !== relPath
      || existing.legacyDigest !== digest) {
      throw new Error(`Legacy lockout creation reference conflict: ${basename}`);
    }
  }

  // Never rename or delete the legacy note; re-read to prove bytes unchanged so far.
  const currentBody = fs.readFileSync(absPath, 'utf8');
  if (contentDigest(currentBody) !== digest) {
    throw new Error(`Legacy lockout note changed during resolve: ${basename}`);
  }

  const resolvedPath = lockoutResolvedPath(project, basename);
  const resolution = {
    schemaVersion: 1,
    resolver,
    reason,
    resolvedAt: new Date().toISOString(),
  };
  const result = writeOrMatchResolution(project, basename, resolvedPath, resolution);
  const afterBody = fs.readFileSync(absPath, 'utf8');
  if (contentDigest(afterBody) !== digest) {
    throw new Error(`Legacy lockout note must not be mutated: ${basename}`);
  }
  return result;
}

function writeOrMatchResolution(project, id, resolvedPath, resolution) {
  if (fs.existsSync(resolvedPath)) {
    const existing = readJsonFile(resolvedPath);
    if (!isValidResolvedRecord(existing)) {
      throw new Error(`Lockout resolution record is invalid: ${id}`);
    }
    if (existing.resolver === resolution.resolver && existing.reason === resolution.reason) {
      return { id, resolvedPath };
    }
    throw new Error(`Lockout already resolved with conflicting inputs: ${id}`);
  }
  writeJsonExclusive(resolvedPath, resolution);
  ledger(project, 'lockout-resolve', { id, resolver: resolution.resolver });
  appendControlEvent(project, {
    type: 'lockout.resolved',
    time: resolution.resolvedAt,
    id,
    resolver: resolution.resolver,
  });
  return { id, resolvedPath };
}

function findLegacyLockout(project, id) {
  if (id.includes('/') || id.includes('\\') || id === '..' || id === '.') return null;
  const orch = path.join(project, '.factory', 'orchestration');
  if (!id.includes('lockout') || !id.endsWith('.md')) return null;
  const absPath = path.join(orch, id);
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return null;
  const body = fs.readFileSync(absPath, 'utf8');
  const fields = parseLegacyLockoutFields(body);
  return {
    basename: id,
    absPath,
    relPath: `.factory/orchestration/${id}`,
    body,
    digest: contentDigest(body),
    agent: fields.agent,
    reviewer: fields.reviewer,
    reason: fields.reason,
  };
}

function legacyLockoutResolved(project, basename) {
  const absPath = path.join(project, '.factory', 'orchestration', basename);
  if (!fs.existsSync(absPath)) return false;
  const body = fs.readFileSync(absPath, 'utf8');
  const digest = contentDigest(body);
  const relPath = `.factory/orchestration/${basename}`;
  const createdPath = lockoutCreatedPath(project, basename);
  const resolvedPath = lockoutResolvedPath(project, basename);
  if (!fs.existsSync(createdPath) || !fs.existsSync(resolvedPath)) return false;
  const created = readJsonFile(createdPath);
  const resolved = readJsonFile(resolvedPath);
  return isValidCreatedRecord(created)
    && created.legacyPath === relPath
    && created.legacyDigest === digest
    && isValidResolvedRecord(resolved);
}

function parseLegacyLockoutFields(body) {
  const agent = (body.match(/^Agent:\s*(.+)$/m) || [])[1]?.trim() || '';
  const reviewer = (body.match(/^Reviewer:\s*(.+)$/m) || [])[1]?.trim() || 'reviewer';
  const reason = (body.match(/^Reason:\s*(.+)$/m) || [])[1]?.trim() || '';
  if (!agent || !/^[a-z0-9-]+$/.test(agent)) {
    throw new Error('legacy lockout note must name a valid Agent');
  }
  return { agent, reviewer, reason };
}

function isValidCreatedRecord(record) {
  return Boolean(
    record
    && record.schemaVersion === 1
    && typeof record.id === 'string'
    && typeof record.agent === 'string'
    && typeof record.reason === 'string'
    && typeof record.createdAt === 'string',
  );
}

function isValidResolvedRecord(record) {
  return Boolean(
    record
    && record.schemaVersion === 1
    && typeof record.resolver === 'string'
    && typeof record.reason === 'string'
    && typeof record.resolvedAt === 'string',
  );
}

function lockoutCreatedPath(project, id) {
  return path.join(project, '.factory', 'orchestration', 'lockouts', id, 'created.json');
}

function lockoutResolvedPath(project, id) {
  return path.join(project, '.factory', 'orchestration', 'lockouts', id, 'resolved.json');
}

function contentDigest(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function writeJsonExclusive(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'wx');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(readText(file));
  } catch {
    return null;
  }
}

function recordDecision(project, id, note, status) {
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id)) {
    throw new Error(`Usage: idefactory ${status === 'accepted' ? 'approve' : 'reject'} <id> --note "..."`);
  }
  if (!note) throw new Error('--note is required');
  const decisions = path.join(project, '.factory', 'decisions.md');
  if (!fs.existsSync(decisions)) throw new Error('No .factory/decisions.md. Run idefactory init first.');
  const stamp = stampNow();
  const entry = `\n## ${stamp.slice(0, 10)} ${status} ${id}\n\nStatus: ${status}\nId: ${id}\nNote: ${note}\n`;
  fs.appendFileSync(decisions, entry.endsWith('\n') ? entry : `${entry}\n`);
  const file = path.join(project, '.factory', 'approvals', `${stamp}-${id}.md`);
  writeText(file, `# ${status} ${id}\n\n${note}\n`);
  ledger(project, status, { id });
  if (status === 'rejected') {
    appendControlEvent(project, {
      type: 'decision.rejected',
      time: new Date().toISOString(),
      id,
    });
  }
  return file;
}

function listChanges(project) {
  const dir = path.join(project, 'openspec', 'changes');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'archive')
    .map((entry) => entry.name)
    .sort();
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(readText(file));
  } catch {
    return null;
  }
}

function stampNow() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
