import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const WRITER_LEASE_SCHEMA_VERSION = 1;
export const WRITER_LEASE_TTL_MS = 5 * 60 * 1000;
export const WRITER_LEASE_HEARTBEAT_MS = 60 * 1000;
export const LEASE_HELD = 'LEASE_HELD';
export const LEASE_RECOVERY = 'LEASE_RECOVERY';
export const OWNERSHIP_LOST = 'OWNERSHIP_LOST';

const READ_ONLY = new Set(['status', 'doctor', 'help', 'attempt show', 'setup detect']);
const MUTATING = new Set([
  'init',
  'upgrade',
  'sync-tasks',
  'next',
  'run',
  'attempt start',
  'attempt transition',
  'verify run',
  'verify import',
  'complete',
  'pr open',
  'pr comment',
  'pr capture',
  'ci scaffold',
  'approve',
  'reject',
  'lockout create',
  'lockout resolve',
  'resume',
  'setup',
]);

/**
 * Absolute path to the project writer lease directory.
 * @param {string} project
 * @returns {string}
 */
export function writerLeaseDir(project) {
  return path.join(project, '.factory', 'orchestration', 'writer.lease');
}

/**
 * Resolve the canonical lease command key for a CLI invocation.
 * @param {string} cmd
 * @param {string[]} [rest]
 * @returns {string}
 */
export function cliCommandKey(cmd, rest = [], flags = {}) {
  const head = String(cmd || '').trim();
  if (head === 'attempt') {
    const sub = String(rest[0] || '').trim();
    if (sub === 'start') return 'attempt start';
    if (sub === 'transition') return 'attempt transition';
    if (sub === 'show') return 'attempt show';
    return sub ? `attempt ${sub}` : 'attempt';
  }
  if (head === 'verify') {
    const sub = String(rest[0] || '').trim();
    if (sub === 'run') return 'verify run';
    if (sub === 'import') return 'verify import';
    return sub ? `verify ${sub}` : 'verify';
  }
  if (head === 'lockout') {
    const sub = String(rest[0] || '').trim();
    if (sub === 'resolve') return 'lockout resolve';
    return 'lockout create';
  }
  if (head === 'pr') {
    const sub = String(rest[0] || '').trim();
    if (sub === 'open') return 'pr open';
    if (sub === 'comment') return 'pr comment';
    if (sub === 'capture') return 'pr capture';
    return sub ? `pr ${sub}` : 'pr';
  }
  if (head === 'ci') {
    const sub = String(rest[0] || '').trim();
    if (sub === 'scaffold') return 'ci scaffold';
    return sub ? `ci ${sub}` : 'ci';
  }
  if (head === 'setup' && flags.detect) return 'setup detect';
  return head;
}

/**
 * @param {string} command
 * @returns {boolean}
 */
export function isReadOnlyCommand(command) {
  return READ_ONLY.has(normalizeCommand(command));
}

/**
 * @param {string} command
 * @returns {boolean}
 */
export function isMutatingCommand(command) {
  return MUTATING.has(normalizeCommand(command));
}

/**
 * @param {string} project
 * @returns {object|null}
 */
export function readWriterLease(project) {
  const file = path.join(writerLeaseDir(project), 'owner.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Atomically acquire the schema version 1 writer lease.
 * Publishes via staging-directory rename so writer.lease is never visible
 * without a complete owner.json (avoids LEASE_RECOVERY races for losers).
 * @param {string} project
 * @param {string} command
 * @param {{ now?: () => number, leaseId?: string }} [options]
 * @returns {object}
 */
export function acquireWriterLease(project, command, options = {}) {
  const nowMs = typeof options.now === 'function' ? options.now() : Date.now();
  const orchestration = path.join(project, '.factory', 'orchestration');
  fs.mkdirSync(orchestration, { recursive: true });

  const leaseDir = writerLeaseDir(project);
  const published = tryPublishNewLease(leaseDir, command, nowMs, options.leaseId);
  if (published) return published;
  return takeoverExpiredLease(project, command, options, nowMs);
}

/**
 * Renew expiry with temp-plus-rename while the stored lease id matches.
 * @param {string} project
 * @param {string} leaseId
 * @param {{ now?: () => number }} [options]
 * @returns {boolean}
 */
export function renewWriterLease(project, leaseId, options = {}) {
  if (typeof leaseId !== 'string' || leaseId.length === 0) return false;
  const nowMs = typeof options.now === 'function' ? options.now() : Date.now();
  const leaseDir = writerLeaseDir(project);
  const owner = safeReadOwner(leaseDir);
  if (!owner || !isValidOwner(owner) || owner.leaseId !== leaseId) return false;

  const renewed = {
    ...owner,
    expiresAt: new Date(nowMs + WRITER_LEASE_TTL_MS).toISOString(),
  };
  const tmp = path.join(leaseDir, `owner.${randomUUID()}.tmp`);
  const target = path.join(leaseDir, 'owner.json');
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(renewed, null, 2)}\n`);
    fs.renameSync(tmp, target);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore cleanup
    }
    return false;
  }

  const stored = safeReadOwner(leaseDir);
  return Boolean(stored && stored.leaseId === leaseId);
}

/**
 * Remove the lease directory only when the stored lease id still matches.
 * Uses atomic rename so a concurrent stale takeover cannot delete a successor.
 * @param {string} project
 * @param {string} leaseId
 * @returns {boolean} true when removed
 */
export function releaseWriterLease(project, leaseId) {
  if (typeof leaseId !== 'string' || leaseId.length === 0) return false;
  const leaseDir = writerLeaseDir(project);
  const owner = safeReadOwner(leaseDir);
  if (!owner || owner.leaseId !== leaseId) return false;

  const tombstone = `${leaseDir}.released-${randomUUID()}`;
  try {
    fs.renameSync(leaseDir, tombstone);
  } catch {
    return false;
  }

  const released = safeReadOwner(tombstone);
  if (!released || released.leaseId !== leaseId) {
    try {
      if (!fs.existsSync(leaseDir)) fs.renameSync(tombstone, leaseDir);
      else fs.rmSync(tombstone, { recursive: true, force: true });
    } catch {
      // leave orphaned tombstone; harmless per design
    }
    return false;
  }

  fs.rmSync(tombstone, { recursive: true, force: true });
  return true;
}

/**
 * Acquire the writer lease, run fn, heartbeat while held, and release in finally.
 * @template T
 * @param {string} project
 * @param {string} command
 * @param {(lease: object) => T|Promise<T>} fn
 * @param {{
 *   now?: () => number,
 *   leaseId?: string,
 *   heartbeatIntervalMs?: number,
 *   setInterval?: typeof setInterval,
 *   clearInterval?: typeof clearInterval,
 * }} [options]
 * @returns {Promise<T>}
 */
export async function withWriterLease(project, command, fn, options = {}) {
  const lease = acquireWriterLease(project, command, options);
  let ownershipLost = false;
  const intervalMs = Number.isFinite(options.heartbeatIntervalMs)
    ? options.heartbeatIntervalMs
    : WRITER_LEASE_HEARTBEAT_MS;
  const schedule = typeof options.setInterval === 'function' ? options.setInterval : setInterval;
  const clear = typeof options.clearInterval === 'function' ? options.clearInterval : clearInterval;

  const timer = schedule(() => {
    if (!renewWriterLease(project, lease.leaseId, options)) ownershipLost = true;
  }, intervalMs);
  if (timer && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();

  try {
    const result = await fn(lease);
    const current = safeReadOwner(writerLeaseDir(project));
    if (ownershipLost || !current || current.leaseId !== lease.leaseId) {
      throw ownershipLostError();
    }
    return result;
  } finally {
    clear(timer);
    releaseWriterLease(project, lease.leaseId);
  }
}

/**
 * Run a read-only command without acquiring or removing the writer lease.
 * @template T
 * @param {string} project
 * @param {string} command
 * @param {() => T|Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withReadOnlyCommand(project, command, fn) {
  if (!isReadOnlyCommand(command)) {
    throw new Error(`command is not read-only: ${command}`);
  }
  return fn();
}

function takeoverExpiredLease(project, command, options, nowMs) {
  const leaseDir = writerLeaseDir(project);
  const observed = readValidatedOwnerOrThrow(leaseDir);
  if (Date.parse(observed.expiresAt) > nowMs) throw leaseHeldError(observed);

  const again = readValidatedOwnerOrThrow(leaseDir);
  if (
    again.leaseId !== observed.leaseId
    || again.expiresAt !== observed.expiresAt
    || Date.parse(again.expiresAt) > nowMs
  ) {
    throw leaseHeldError(again);
  }

  const stale = `${leaseDir}.stale-${randomUUID()}`;
  try {
    fs.renameSync(leaseDir, stale);
  } catch {
    throw leaseHeldError(again);
  }

  const tomb = safeReadOwner(stale);
  if (
    !tomb
    || !isValidOwner(tomb)
    || tomb.leaseId !== observed.leaseId
    || tomb.expiresAt !== observed.expiresAt
    || Date.parse(tomb.expiresAt) > nowMs
  ) {
    try {
      if (!fs.existsSync(leaseDir)) fs.renameSync(stale, leaseDir);
    } catch {
      // leave tombstone
    }
    throw leaseHeldError(tomb || again);
  }

  const published = tryPublishNewLease(leaseDir, command, nowMs, options.leaseId);
  if (published) {
    fs.rmSync(stale, { recursive: true, force: true });
    return published;
  }

  // Another contender published first; do not restore stale over a successor.
  try {
    if (!fs.existsSync(leaseDir)) fs.renameSync(stale, leaseDir);
    else fs.rmSync(stale, { recursive: true, force: true });
  } catch {
    // leave tombstone; harmless per design
  }
  throw leaseHeldError(again);
}

/**
 * Build a complete lease in a private staging directory, then rename into place.
 * @returns {object|null} owner when published; null when the final path is occupied
 */
function tryPublishNewLease(leaseDir, command, nowMs, leaseId) {
  if (fs.existsSync(leaseDir)) return null;

  const staging = `${leaseDir}.staging-${randomUUID()}`;
  fs.mkdirSync(staging);
  let owner;
  try {
    owner = writeNewOwner(staging, command, nowMs, leaseId);
  } catch (error) {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      // ignore
    }
    throw error;
  }

  try {
    fs.renameSync(staging, leaseDir);
    return owner;
  } catch (error) {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      // ignore
    }
    if (error && (error.code === 'ENOTEMPTY' || error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'EBUSY')) {
      return null;
    }
    // Destination appeared between existsSync and rename (another publisher won).
    if (fs.existsSync(leaseDir)) return null;
    throw error;
  }
}

function writeNewOwner(leaseDir, command, nowMs, leaseId) {
  const acquiredAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + WRITER_LEASE_TTL_MS).toISOString();
  const owner = {
    schemaVersion: WRITER_LEASE_SCHEMA_VERSION,
    leaseId: leaseId || randomUUID(),
    command: normalizeCommand(command),
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt,
    expiresAt,
  };
  fs.writeFileSync(
    path.join(leaseDir, 'owner.json'),
    `${JSON.stringify(owner, null, 2)}\n`,
  );
  return owner;
}

function normalizeCommand(command) {
  return String(command || '').trim().replace(/\s+/g, ' ');
}

function safeReadOwner(leaseDir) {
  const file = path.join(leaseDir, 'owner.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isValidOwner(owner) {
  if (!owner || typeof owner !== 'object') return false;
  if (owner.schemaVersion !== WRITER_LEASE_SCHEMA_VERSION) return false;
  if (typeof owner.leaseId !== 'string' || owner.leaseId.length === 0) return false;
  if (typeof owner.command !== 'string') return false;
  if (typeof owner.acquiredAt !== 'string' || !Number.isFinite(Date.parse(owner.acquiredAt))) return false;
  if (typeof owner.expiresAt !== 'string' || !Number.isFinite(Date.parse(owner.expiresAt))) return false;
  return true;
}

function readValidatedOwnerOrThrow(leaseDir) {
  const file = path.join(leaseDir, 'owner.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    // A concurrent stale-rename winner removes the directory; that is LEASE_HELD,
    // not corrupt recovery. An existing directory without a readable owner fails closed.
    if (error && error.code === 'ENOENT' && !fs.existsSync(leaseDir)) {
      throw leaseHeldError(null);
    }
    throw leaseRecoveryError('writer lease record is unreadable');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw leaseRecoveryError('writer lease record is corrupt');
  }
  if (!isValidOwner(parsed)) {
    throw leaseRecoveryError('writer lease schema is unsupported or invalid');
  }
  return parsed;
}

function leaseHeldError(owner) {
  const error = new Error(
    owner?.leaseId
      ? `writer lease held (leaseId=${owner.leaseId}, command=${owner.command || 'unknown'})`
      : 'writer lease held',
  );
  error.code = LEASE_HELD;
  error.owner = owner;
  return error;
}

function leaseRecoveryError(message) {
  const error = new Error(message);
  error.code = LEASE_RECOVERY;
  return error;
}

function ownershipLostError() {
  const error = new Error('writer lease ownership lost');
  error.code = OWNERSHIP_LOST;
  return error;
}
