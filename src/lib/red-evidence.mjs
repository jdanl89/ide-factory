const NO_TESTS = /no tests|0 tests|no test files found|missing script|not recognized/i;

const EXACT_TEST_KINDS = new Set(['unit', 'integration', 'playwright', 'contract']);

export function isRequiredTestKind(kind) {
  return EXACT_TEST_KINDS.has(kind) || String(kind || '').startsWith('unit-');
}

export function requiredTestKinds(checks) {
  return (Array.isArray(checks) ? checks : []).filter((kind) => isRequiredTestKind(kind));
}

/**
 * A new red lives at evidence.reds[kind]. A legacy evidence.red counts for its
 * kind only when evidence.reds is absent.
 * @param {object} attempt
 * @param {string} kind
 */
export function redForKind(attempt, kind) {
  const reds = attempt?.evidence?.reds;
  if (reds && typeof reds === 'object' && !Array.isArray(reds)) {
    return reds[kind] || null;
  }
  const legacy = attempt?.evidence?.red;
  if (legacy && typeof legacy === 'object' && legacy.kind === kind) return legacy;
  return null;
}

export function isFailingRed(record) {
  if (!record || typeof record !== 'object') return false;
  if (record.issuer !== 'cli') return false;
  if (record.exitCode === undefined || record.exitCode === null || record.exitCode === 0) return false;
  return true;
}

export function hasAnyFailingRed(attempt) {
  const reds = attempt?.evidence?.reds;
  if (reds && typeof reds === 'object' && !Array.isArray(reds)) {
    return Object.values(reds).some((record) => isFailingRed(record));
  }
  return isFailingRed(attempt?.evidence?.red);
}

/**
 * @param {{ spawnError?: unknown, timedOut?: boolean, exitCode?: number|null, output?: string, asRed?: boolean }} outcome
 * @returns {'infrastructure-failure'|'vacuous-red'|'passed'|'assertion-failure'}
 */
export function classifyCheckOutcome(outcome) {
  const output = outcome.output || '';
  if (outcome.spawnError || outcome.timedOut || outcome.exitCode === 127) return 'infrastructure-failure';
  if (NO_TESTS.test(output)) return 'infrastructure-failure';
  if (outcome.exitCode === 0) return outcome.asRed ? 'vacuous-red' : 'passed';
  return 'assertion-failure';
}

export function retryKey(classification, kind) {
  if (classification === 'review-rejection') return 'review-rejection';
  return `${classification}:${kind}`;
}
