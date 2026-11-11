import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { attemptsRoot } from './attempt.mjs';
import { ledger } from './layout.mjs';
import { listWorkItems } from './work.mjs';

const SUPPORTED_SCHEMA_VERSION = 1;

const REQUIRED_BUDGET_KEYS = [
  'maxAgentSteps',
  'maxTasks',
  'maxWallClockMs',
  'maxFailures',
];

/** Built-in positive defaults when config keys are absent (design.md). */
export const BUILTIN_RUN_BUDGETS = {
  maxAgentSteps: 20,
  maxTasks: 20,
  maxWallClockMs: 14_400_000,
  maxFailures: 5,
};

/** Stop reasons that stay exhausted until `--new-run` (design.md). */
export const STICKY_STOP_REASONS = new Set([
  'max-agent-steps',
  'max-tasks',
  'wall-clock',
  'max-failures',
  'unchanged-state',
  'max-tokens',
  'max-cost',
  'invalid-budget',
  'invalid-session',
  'host-usage-unavailable',
  'vacuous-red',
  'retry-cap',
]);

export class InvalidBudgetError extends Error {
  constructor(message = 'invalid-budget') {
    super(message);
    this.name = 'InvalidBudgetError';
    this.code = 'INVALID_BUDGET';
  }
}

/**
 * Validate a schema version 1 run-session object.
 * Rejects unsupported schema versions and missing required fields.
 *
 * @param {unknown} session
 * @returns {object}
 */
export function validateRunSession(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    throw new Error('run session must be an object');
  }
  if (session.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(`unsupported run session schema version: ${session.schemaVersion}`);
  }

  requireString(session, 'runId');
  requireString(session, 'change');
  requireString(session, 'startedAt');

  if (session.status !== 'open' && session.status !== 'closed') {
    throw new Error('run session status must be "open" or "closed"');
  }

  const budgets = session.budgets;
  if (!budgets || typeof budgets !== 'object' || Array.isArray(budgets)) {
    throw new Error('run session requires budgets object');
  }
  for (const key of REQUIRED_BUDGET_KEYS) {
    if (!Number.isInteger(budgets[key]) || budgets[key] <= 0) {
      throw new Error(`run session budgets.${key} must be a positive integer`);
    }
  }

  requireNonNegativeInteger(session, 'agentSteps');
  requireNonNegativeInteger(session, 'completedTasks');
  requireNonNegativeInteger(session, 'failureCount');

  if (!('lastRequestFingerprint' in session)) {
    throw new Error('run session requires lastRequestFingerprint');
  }
  if (!('stopReason' in session)) {
    throw new Error('run session requires stopReason');
  }

  return {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    runId: session.runId,
    change: session.change,
    status: session.status,
    startedAt: session.startedAt,
    lastObservedAt: session.lastObservedAt ?? null,
    budgets: {
      maxAgentSteps: budgets.maxAgentSteps,
      maxTasks: budgets.maxTasks,
      maxWallClockMs: budgets.maxWallClockMs,
      maxFailures: budgets.maxFailures,
      ...(budgets.maxTokens !== undefined ? { maxTokens: budgets.maxTokens } : {}),
      ...(budgets.maxCost !== undefined ? { maxCost: budgets.maxCost } : {}),
    },
    agentSteps: session.agentSteps,
    completedTasks: session.completedTasks,
    failureCount: session.failureCount,
    baselineDoneIds: Array.isArray(session.baselineDoneIds) ? [...session.baselineDoneIds] : [],
    baselineFailureIds: Array.isArray(session.baselineFailureIds)
      ? [...session.baselineFailureIds]
      : [],
    countedFailureIds: Array.isArray(session.countedFailureIds)
      ? [...session.countedFailureIds]
      : [],
    lastRequestFingerprint: session.lastRequestFingerprint ?? null,
    stopReason: session.stopReason ?? null,
    ...(session.testBaseline ? { testBaseline: session.testBaseline } : {}),
    ...(session.hostTokens !== undefined ? { hostTokens: session.hostTokens } : {}),
    ...(session.hostCost !== undefined ? { hostCost: session.hostCost } : {}),
  };
}

/**
 * Read and validate a run-session file. On parse or schema failure the file
 * bytes are left unchanged and no replacement file is written.
 *
 * @param {string} filePath
 * @returns {object}
 */
export function readRunSession(filePath) {
  const bytes = fs.readFileSync(filePath);
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    throw new Error(`invalid run session JSON: ${err.message}`);
  }
  return validateRunSession(parsed);
}

export function runsDir(project) {
  return path.join(project, '.factory', 'orchestration', 'runs');
}

export function runSessionPath(project, runId) {
  return path.join(runsDir(project), `${runId}.json`);
}

/**
 * Persist a validated session via temp file + rename.
 *
 * @param {string} project
 * @param {object} session
 * @returns {object}
 */
export function writeRunSession(project, session) {
  const validated = validateRunSession(session);
  const dir = runsDir(project);
  fs.mkdirSync(dir, { recursive: true });
  const target = runSessionPath(project, validated.runId);
  const tmp = path.join(dir, `.${validated.runId}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`);
  fs.renameSync(tmp, target);
  return validated;
}

/**
 * Latest session for a change by greatest startedAt, or null.
 *
 * @param {string} project
 * @param {string} change
 * @returns {object|null}
 */
export function closeLatestRunSession(project, change, stopReason) {
  const existing = latestRunSession(project, change);
  if (!existing) return null;
  return writeRunSession(project, {
    ...existing,
    status: 'closed',
    stopReason,
    lastObservedAt: new Date().toISOString(),
  });
}

export function latestRunSession(project, change) {
  const dir = runsDir(project);
  if (!fs.existsSync(dir)) return null;
  let latest = null;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const session = readRunSession(path.join(dir, name));
    if (session.change !== change) continue;
    if (!latest || session.startedAt > latest.startedAt) latest = session;
  }
  return latest;
}

/**
 * Resolve budgets for a new session: CLI/config, then built-in positive defaults.
 * Does not invent token/cost ceilings.
 *
 * @param {object} config
 * @param {{ maxTasks?: number|string, maxAgentSteps?: number|string }} [flags]
 * @returns {object}
 */
/**
 * On resume, CLI flags may tighten stored budgets but never raise them.
 *
 * @param {object} storedBudgets
 * @param {{ maxTasks?: number|string, maxAgentSteps?: number|string }} [flags]
 * @param {object} [config]
 * @returns {object}
 */
export function mergeResumeBudgets(storedBudgets, { maxTasks, maxAgentSteps } = {}, config = {}) {
  const merged = { ...storedBudgets };
  if (maxAgentSteps !== undefined && maxAgentSteps !== '') {
    const requested = resolveCliBudget(
      maxAgentSteps,
      undefined,
      merged.maxAgentSteps,
      'max-agent-steps',
    );
    merged.maxAgentSteps = Math.min(merged.maxAgentSteps, requested);
  }
  if (maxTasks !== undefined && maxTasks !== '') {
    const requested = resolveCliBudget(
      maxTasks,
      undefined,
      merged.maxTasks,
      'max-tasks',
    );
    merged.maxTasks = Math.min(merged.maxTasks, requested);
  }
  return merged;
}

export function resolveNewSessionBudgets(config = {}, {
  maxTasks,
  maxAgentSteps,
  maxTokens,
  maxCost,
} = {}) {
  const run = config.run || {};
  const budgets = {
    maxAgentSteps: resolveCliBudget(
      maxAgentSteps,
      run.defaultMaxAgentSteps,
      BUILTIN_RUN_BUDGETS.maxAgentSteps,
      'max-agent-steps',
    ),
    maxTasks: resolveCliBudget(
      maxTasks,
      run.defaultMaxTasks,
      BUILTIN_RUN_BUDGETS.maxTasks,
      'max-tasks',
    ),
    maxWallClockMs: resolveRequiredBudget(
      undefined,
      run.defaultMaxWallClockMs,
      BUILTIN_RUN_BUDGETS.maxWallClockMs,
      'maxWallClockMs',
    ),
    maxFailures: resolveRequiredBudget(
      undefined,
      run.defaultMaxFailures,
      BUILTIN_RUN_BUDGETS.maxFailures,
      'maxFailures',
    ),
  };
  const tokenCeiling = resolveOptionalTokenCeiling(maxTokens, run.maxTokens, 'max-tokens');
  const costCeiling = resolveOptionalCostCeiling(maxCost, run.maxCost, 'max-cost');
  if (tokenCeiling !== undefined) budgets.maxTokens = tokenCeiling;
  if (costCeiling !== undefined) budgets.maxCost = costCeiling;
  return budgets;
}

/**
 * Parse host usage only when the invocation exposes it via CLI or env.
 *
 * @param {string|number|boolean|undefined} flagValue
 * @param {string|undefined} envValue
 * @param {{ label: string, integer?: boolean }} options
 * @returns {number|undefined}
 */
export function parseExposedHostMetric(flagValue, envValue, { label, integer = false } = {}) {
  const hasFlag = flagValue !== undefined && flagValue !== '' && flagValue !== true;
  const hasEnv = envValue != null && String(envValue).length > 0;
  if (!hasFlag && !hasEnv) return undefined;
  const raw = hasFlag ? flagValue : envValue;
  if (raw === true || raw === false) {
    throw new InvalidBudgetError(`invalid-budget: ${label} must be a non-negative ${integer ? 'integer' : 'number'}`);
  }
  const n = Number(raw);
  if (integer) {
    if (!Number.isInteger(n) || n < 0) {
      throw new InvalidBudgetError(`invalid-budget: ${label} must be a non-negative integer`);
    }
  } else if (!Number.isFinite(n) || n < 0) {
    throw new InvalidBudgetError(`invalid-budget: ${label} must be a non-negative number`);
  }
  return n;
}

/**
 * Compare configured token/cost ceilings with exposed host metrics.
 *
 * @param {object} session
 * @param {{ hostTokens?: number, hostCost?: number }} hostUsage
 * @returns {{ code: number, stopReason: string, patch?: object }|null}
 */
export function checkHostUsageBudgets(session, { hostTokens, hostCost } = {}) {
  const { budgets } = session;
  if (budgets.maxTokens !== undefined) {
    if (hostTokens === undefined) {
      return { code: 1, stopReason: 'host-usage-unavailable' };
    }
    if (hostTokens >= budgets.maxTokens) {
      return { code: 0, stopReason: 'max-tokens', patch: { hostTokens } };
    }
  }
  if (budgets.maxCost !== undefined) {
    if (hostCost === undefined) {
      return { code: 1, stopReason: 'host-usage-unavailable' };
    }
    if (hostCost >= budgets.maxCost) {
      return { code: 0, stopReason: 'max-cost', patch: { hostCost } };
    }
  }
  return null;
}

/**
 * Best-effort parse of `.factory/ledger.jsonl`. Read failures yield [].
 *
 * @param {string} project
 * @returns {object[]}
 */
export function readLedgerEvents(project) {
  const file = path.join(project, '.factory', 'ledger.jsonl');
  if (!fs.existsSync(file)) return [];
  try {
    const text = fs.readFileSync(file, 'utf8');
    const events = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // Skip malformed lines; ledger is observational.
      }
    }
    return events;
  } catch {
    return [];
  }
}

/**
 * Run ids with `run-session-opened` for the change, no `run-session-closed`,
 * and no session file on disk.
 *
 * @param {string} project
 * @param {string} change
 * @returns {string[]}
 */
export function unmatchedOpenRunIds(project, change) {
  const opened = new Set();
  const closed = new Set();
  for (const event of readLedgerEvents(project)) {
    if (!event || typeof event.runId !== 'string' || !event.runId) continue;
    if (event.event === 'run-session-closed') {
      closed.add(event.runId);
      continue;
    }
    if (event.event === 'run-session-opened' && event.change === change) {
      opened.add(event.runId);
    }
  }
  const unmatched = [];
  for (const runId of opened) {
    if (closed.has(runId)) continue;
    if (!fs.existsSync(runSessionPath(project, runId))) unmatched.push(runId);
  }
  return unmatched;
}

/**
 * Highest `agentSteps` recorded in ledger `run-agent-step` lines for a run id.
 *
 * @param {string} project
 * @param {string} runId
 * @returns {number}
 */
export function ledgerAgentStepHighWater(project, runId) {
  let high = 0;
  for (const event of readLedgerEvents(project)) {
    if (event?.event !== 'run-agent-step' || event.runId !== runId) continue;
    const n = Number(event.agentSteps);
    if (Number.isInteger(n) && n > high) high = n;
  }
  return high;
}

/**
 * Done work-item ids for a change (stable sort).
 *
 * @param {string} project
 * @param {string} change
 * @returns {string[]}
 */
export function doneWorkItemIds(project, change) {
  return listWorkItems(project, change)
    .filter((item) => item.status === 'done')
    .map((item) => item.id)
    .sort();
}

/**
 * Count work items that became done after session creation (not in baseline).
 *
 * @param {string} project
 * @param {object} session
 * @returns {number}
 */
export function countCompletedTasksDuringSession(project, session) {
  const baseline = new Set(session.baselineDoneIds || []);
  return doneWorkItemIds(project, session.change)
    .filter((id) => !baseline.has(id))
    .length;
}

/**
 * Persist refreshed completedTasks from current done ids minus baselineDoneIds.
 *
 * @param {string} project
 * @param {object} session
 * @param {{ now?: Date }} [options]
 * @returns {object}
 */
export function refreshCompletedTasks(project, session, { now = new Date() } = {}) {
  const completedTasks = countCompletedTasksDuringSession(project, session);
  if (completedTasks === session.completedTasks) {
    return session;
  }
  return writeRunSession(project, {
    ...session,
    completedTasks,
    lastObservedAt: now.toISOString(),
  });
}

/**
 * Stable id for a verification record when counting tool failures.
 *
 * @param {string} attemptId
 * @param {object} record
 * @returns {string}
 */
export function failureRecordId(attemptId, record) {
  if (record?.id) return String(record.id);
  const digest = record?.commandDigest ?? '';
  const startedAt = record?.startedAt ?? '';
  return `${attemptId}:${startedAt}:${digest}`;
}

function isCountableVerificationFailure(record) {
  if (!record || typeof record !== 'object') return false;
  return record.timedOut === true || record.passed === false;
}

function recordMatchesRed(record, red) {
  if (!red || !record) return false;
  if (red.id && record.id && red.id === record.id) return true;
  return red.attemptId === record.attemptId
    && red.startedAt === record.startedAt
    && red.commandDigest === record.commandDigest;
}

/**
 * Distinct timed-out or non-passing verification record ids for a change,
 * excluding records stored as red evidence.
 *
 * @param {string} project
 * @param {string} change
 * @returns {string[]}
 */
export function collectFailureRecordIds(project, change) {
  const root = attemptsRoot(project);
  if (!fs.existsSync(root)) return [];
  const ids = new Set();
  for (const name of fs.readdirSync(root)) {
    if (!name.endsWith('.json')) continue;
    let attempt;
    try {
      attempt = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
    } catch {
      continue;
    }
    if (attempt.change !== change) continue;
    const red = attempt.evidence?.red;
    for (const record of attempt.evidence?.verification || []) {
      if (!isCountableVerificationFailure(record)) continue;
      if (recordMatchesRed(record, red)) continue;
      ids.add(failureRecordId(attempt.id, record));
    }
  }
  return [...ids].sort();
}

/**
 * Persist failureCount and countedFailureIds from verification records.
 *
 * @param {string} project
 * @param {object} session
 * @param {{ now?: Date }} [options]
 * @returns {object}
 */
export function refreshFailures(project, session, { now = new Date() } = {}) {
  const baseline = new Set(session.baselineFailureIds || []);
  const allIds = collectFailureRecordIds(project, session.change);
  const counted = new Set(session.countedFailureIds || []);
  let changed = false;
  for (const id of allIds) {
    if (baseline.has(id)) continue;
    if (!counted.has(id)) {
      counted.add(id);
      changed = true;
    }
  }
  const failureCount = counted.size;
  if (!changed && failureCount === session.failureCount) {
    return session;
  }
  return writeRunSession(project, {
    ...session,
    failureCount,
    countedFailureIds: [...counted].sort(),
    lastObservedAt: now.toISOString(),
  });
}

/**
 * Create a new open session file for the change.
 * Captures baselineDoneIds from work already done so they are not charged.
 * Appends best-effort `run-session-opened` to the ledger (non-blocking).
 *
 * @param {string} project
 * @param {{ change: string, budgets: object, now?: Date }} options
 * @returns {object}
 */
export function createRunSession(project, { change, budgets, now = new Date() } = {}) {
  if (!change) throw new Error('createRunSession requires change');
  const startedAt = now.toISOString();
  const baselineDoneIds = doneWorkItemIds(project, change);
  const baselineFailureIds = collectFailureRecordIds(project, change);
  const session = writeRunSession(project, {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    runId: randomUUID(),
    change,
    status: 'open',
    startedAt,
    lastObservedAt: startedAt,
    budgets,
    agentSteps: 0,
    completedTasks: 0,
    failureCount: 0,
    baselineDoneIds,
    baselineFailureIds,
    countedFailureIds: [],
    lastRequestFingerprint: null,
    stopReason: null,
  });
  // Best-effort: ledger() swallows write errors and must not block the run.
  ledger(project, 'run-session-opened', { change, runId: session.runId });
  return session;
}

/**
 * Resume the latest session for a change, or create one when none exists.
 * Resume preserves run id and counters; budgets are only applied on create.
 * Ledger tripwire: unmatched opened ids with no file refuse create; ledger
 * agent-step high-water above the file refuses resume (file left unchanged).
 *
 * @param {string} project
 * @param {{ change: string, budgets: object, now?: Date, newRun?: boolean, resumeFlags?: object, config?: object }} options
 * @returns {object}
 */
export function openOrResumeRunSession(project, {
  change,
  budgets,
  now = new Date(),
  newRun = false,
  resumeFlags = {},
  config = {},
} = {}) {
  if (!change) throw new Error('openOrResumeRunSession requires change');
  const existing = latestRunSession(project, change);
  if (newRun && existing) {
    return createRunSession(project, { change, budgets, now });
  }
  if (existing) {
    if (existing.status === 'closed' && STICKY_STOP_REASONS.has(existing.stopReason)) {
      return existing;
    }
    const highWater = ledgerAgentStepHighWater(project, existing.runId);
    if (highWater > existing.agentSteps) {
      throw new Error(
        `invalid-session: ledger agent-step high-water ${highWater} exceeds session file agentSteps ${existing.agentSteps}`,
      );
    }
    const mergedBudgets = mergeResumeBudgets(existing.budgets, resumeFlags, config);
    return writeRunSession(project, {
      ...existing,
      budgets: mergedBudgets,
      lastObservedAt: now.toISOString(),
    });
  }
  const unmatched = unmatchedOpenRunIds(project, change);
  if (unmatched.length > 0) {
    throw new Error(
      `invalid-session: ledger run-session-opened for ${unmatched[0]} has no session file and no close line`,
    );
  }
  return createRunSession(project, { change, budgets, now });
}

function resolveCliBudget(flagValue, configValue, fallback, label) {
  if (flagValue === undefined || flagValue === '') {
    return resolveRequiredBudget(undefined, configValue, fallback, label);
  }
  if (flagValue === true || flagValue === false) {
    throw new InvalidBudgetError(`invalid-budget: ${label} must be a positive integer`);
  }
  return resolveRequiredBudget(flagValue, undefined, fallback, label);
}

function resolveRequiredBudget(explicit, configValue, fallback, label) {
  const raw = explicit !== undefined ? explicit : configValue;
  if (raw == null || raw === '') return fallback;
  if (raw === true || raw === false) {
    throw new InvalidBudgetError(`invalid-budget: ${label} must be a positive integer`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidBudgetError(`invalid-budget: ${label} must be a positive integer`);
  }
  return n;
}

function resolveOptionalTokenCeiling(flagValue, configValue, label) {
  const raw = flagValue !== undefined && flagValue !== '' ? flagValue : configValue;
  if (raw == null || raw === '') return undefined;
  if (raw === true || raw === false) {
    throw new InvalidBudgetError(`invalid-budget: ${label} must be a positive integer`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidBudgetError(`invalid-budget: ${label} must be a positive integer`);
  }
  return n;
}

function resolveOptionalCostCeiling(flagValue, configValue, label) {
  const raw = flagValue !== undefined && flagValue !== '' ? flagValue : configValue;
  if (raw == null || raw === '') return undefined;
  if (raw === true || raw === false) {
    throw new InvalidBudgetError(`invalid-budget: ${label} must be a positive number`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InvalidBudgetError(`invalid-budget: ${label} must be a positive number`);
  }
  return n;
}

function requireString(session, key) {
  if (typeof session[key] !== 'string' || session[key].length === 0) {
    throw new Error(`run session requires non-empty string ${key}`);
  }
}

function requireNonNegativeInteger(session, key) {
  if (!Number.isInteger(session[key]) || session[key] < 0) {
    throw new Error(`run session requires non-negative integer ${key}`);
  }
}
