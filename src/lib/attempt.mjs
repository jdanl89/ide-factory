import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ledger, writeText } from './layout.mjs';
import {
  commentOnPullRequest,
  postVerdictComment,
  readPullRequestRecord,
} from './pull-request.mjs';
import {
  assertPassingCliSecurityEvidence,
  requiresSecurityStage,
} from './risk-gates.mjs';
import { getWorkItem, updateWorkItem } from './work.mjs';
import { hasAnyFailingRed, isFailingRed, redForKind, requiredTestKinds, retryKey } from './red-evidence.mjs';

export const ATTEMPT_STATES = [
  'planned',
  'assigned',
  'implementing',
  'red-confirmed',
  'verifying',
  'security-checking',
  'awaiting-review',
  'accepted',
  'rejected',
  'finalized',
  'finalize-failed',
];

const TRANSITIONS = {
  planned: ['assigned'],
  assigned: ['implementing'],
  implementing: ['red-confirmed', 'verifying'],
  'red-confirmed': ['verifying'],
  verifying: ['security-checking', 'awaiting-review'],
  'security-checking': ['awaiting-review', 'rejected'],
  'awaiting-review': ['accepted', 'rejected'],
  accepted: ['finalized', 'finalize-failed'],
  rejected: [],
  finalized: [],
  'finalize-failed': ['finalized'],
};

export function attemptsRoot(project) {
  return path.join(project, '.factory', 'attempts');
}

export function attemptPath(project, attemptId) {
  return path.join(attemptsRoot(project), `${attemptId}.json`);
}

export function getAttempt(project, attemptId) {
  const file = attemptPath(project, attemptId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function startAttempt(project, change, taskId, { role = 'engineer', modelProfile = 'coding-standard' } = {}) {
  const item = getWorkItem(project, change, taskId);
  if (!item) throw new Error(`Work item not found: ${change}/${taskId}`);
  if (item.status === 'done') throw new Error(`Work item already done: ${change}/${taskId}`);

  const attemptId = randomUUID();
  const attempt = {
    id: attemptId,
    change,
    taskId,
    state: 'planned',
    implementerRole: role,
    implementerId: null,
    reviewerId: null,
    modelProfile,
    evidence: {
      red: null,
      verification: [],
      security: [],
      review: null,
      changedFiles: [],
      baseRev: null,
    },
    history: [{ at: new Date().toISOString(), state: 'planned' }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(attemptsRoot(project), { recursive: true });
  writeText(attemptPath(project, attemptId), JSON.stringify(attempt, null, 2));
  updateWorkItem(project, change, taskId, { status: 'in_progress', attemptId });
  ledger(project, 'attempt-start', { attemptId, change, taskId });
  return transitionAttempt(project, attemptId, 'assigned', {
    evidence: { assignedRole: role },
  });
}

export function transitionAttempt(project, attemptId, nextState, {
  evidence = {},
  actorId = null,
  env = process.env,
} = {}) {
  const attempt = getAttempt(project, attemptId);
  if (!attempt) throw new Error(`Attempt not found: ${attemptId}`);
  const allowed = TRANSITIONS[attempt.state] || [];
  if (!allowed.includes(nextState)) {
    throw new Error(`Illegal transition ${attempt.state} → ${nextState}`);
  }
  // Reject check-result payloads before any mutation so the attempt file stays unchanged.
  rejectCallerSuppliedCheckResults(evidence);
  validateEvidence(project, attempt, nextState, evidence);
  if (nextState === 'rejected' && (attempt.state === 'awaiting-review' || attempt.state === 'security-checking')) {
    const key = retryKey('review-rejection');
    const counts = { ...(attempt.evidence.retryCounts || {}) };
    counts[key] = (counts[key] || 0) + 1;
    attempt.evidence.retryCounts = counts;
    if (counts[key] >= 4) {
      attempt.updatedAt = new Date().toISOString();
      writeText(attemptPath(project, attemptId), JSON.stringify(attempt, null, 2));
      throw new Error('retry-cap: review rejection refused');
    }
  }

  if (nextState === 'implementing' && actorId) attempt.implementerId = actorId;
  const mainReviewerVerdict = attempt.state === 'awaiting-review'
    && (nextState === 'accepted' || nextState === 'rejected');
  if (mainReviewerVerdict) {
    attempt.reviewerId = evidence.reviewerId || actorId || attempt.reviewerId;
    attempt.evidence.review = {
      verdict: nextState === 'accepted' ? 'ACCEPT' : 'REJECT',
      role: 'reviewer',
      reviewerId: attempt.reviewerId,
      notes: evidence.notes || '',
      at: new Date().toISOString(),
    };
  }
  const securityVerdict = securityHandoffVerdict(attempt, nextState, evidence);
  const securityReviewerId = securityReviewerIdFrom(evidence);
  if (securityVerdict) {
    attempt.evidence.securityReview = {
      verdict: securityVerdict,
      role: 'security-reviewer',
      ...(securityReviewerId ? { reviewerId: securityReviewerId } : {}),
    };
  }
  mergeEvidence(attempt, nextState, evidence);
  attempt.state = nextState;
  attempt.updatedAt = new Date().toISOString();
  attempt.history.push({ at: attempt.updatedAt, state: nextState });
  writeText(attemptPath(project, attemptId), JSON.stringify(attempt, null, 2));
  ledger(project, 'attempt-transition', { attemptId, state: nextState });

  // Task 1.1: post the stored accept/reject verdict once a pull request record exists.
  // Missing-record and dedupe behavior are covered by later tasks; skip when absent.
  if (mainReviewerVerdict) {
    if (readPullRequestRecord(project, attempt.change)) {
      commentOnPullRequest(project, attemptId, env);
    }
  }
  if (securityVerdict && readPullRequestRecord(project, attempt.change)) {
    postVerdictComment(project, {
      attemptId,
      verdict: securityVerdict,
      role: 'security-reviewer',
      ...(securityReviewerId ? { reviewerId: securityReviewerId } : {}),
    }, env);
  }

  return attempt;
}

function securityHandoffVerdict(attempt, nextState, evidence) {
  if (
    attempt.state !== 'security-checking'
    || !['awaiting-review', 'rejected'].includes(nextState)
  ) return '';
  if (typeof evidence?.verdict !== 'string') return '';
  return evidence.verdict.trim();
}

function securityReviewerIdFrom(evidence) {
  if (typeof evidence?.securityReviewerId !== 'string') return '';
  return evidence.securityReviewerId.trim();
}

function rejectCallerSuppliedCheckResults(evidence) {
  if (!evidence || typeof evidence !== 'object') return;
  for (const key of ['red', 'verification', 'security']) {
    if (Object.prototype.hasOwnProperty.call(evidence, key)) {
      throw new Error(
        `attempt transition rejects caller-supplied ${key} check results; use idefactory verify run`,
      );
    }
  }
}

function validateEvidence(project, attempt, nextState, evidence) {
  if (nextState === 'red-confirmed') {
    if (!hasAnyFailingRed(attempt)) {
      throw new Error(
        'red-confirmed requires stored evidence.red from verify run (passed:false); do not supply red in the transition payload',
      );
    }
  }
  if (nextState === 'verifying') {
    const item = getWorkItem(project, attempt.change, attempt.taskId);
    const taskType = item?.factory?.taskType === 'lightweight' ? 'lightweight' : 'code';
    if (taskType !== 'lightweight') {
      const missing = requiredTestKinds(item?.factory?.checks).filter((kind) => !isFailingRed(redForKind(attempt, kind)));
      if (missing.length) {
        throw new Error(`verifying requires a recorded failing CLI red for: ${missing.join(', ')}`);
      }
    }
  }
  if (nextState === 'awaiting-review' && attempt.state === 'verifying') {
    const item = getWorkItem(project, attempt.change, attempt.taskId);
    if (requiresSecurityStage(item)) {
      throw new Error(
        'security-sensitive work cannot transition verifying → awaiting-review; remain in verifying and use security-checking',
      );
    }
  }
  if (nextState === 'awaiting-review' && attempt.state === 'security-checking') {
    const item = getWorkItem(project, attempt.change, attempt.taskId);
    assertPassingCliSecurityEvidence(project, attempt, item);
    if (requiresSecurityStage(item)) {
      assertSecurityReviewerVerdict(attempt, evidence, 'ACCEPT');
    }
  }
  if (nextState === 'rejected' && attempt.state === 'security-checking') {
    const item = getWorkItem(project, attempt.change, attempt.taskId);
    if (!requiresSecurityStage(item)) {
      throw new Error(
        'only security-stage work can transition security-checking → rejected',
      );
    }
    assertSecurityReviewerVerdict(attempt, evidence, 'REJECT');
  }
  if (nextState === 'accepted') {
    if (!evidence.reviewerId && !attempt.reviewerId) {
      throw new Error('accepted requires evidence.reviewerId');
    }
    if (evidence.verdict && String(evidence.verdict).toUpperCase() !== 'ACCEPT') {
      throw new Error('accepted requires verdict ACCEPT');
    }
  }
  if (
    nextState === 'rejected'
    && attempt.state === 'awaiting-review'
    && !evidence.reviewerId
    && !attempt.reviewerId
  ) {
    throw new Error('rejected requires evidence.reviewerId');
  }
}

function assertSecurityReviewerVerdict(attempt, evidence, requiredVerdict) {
  const verdict = typeof evidence?.verdict === 'string'
    ? evidence.verdict.trim().toUpperCase()
    : '';
  if (verdict !== requiredVerdict) {
    throw new Error(
      `security-stage work requires verdict ${requiredVerdict} to leave security-checking`,
    );
  }
  const securityReviewerId = typeof evidence?.securityReviewerId === 'string'
    ? evidence.securityReviewerId.trim()
    : '';
  if (!securityReviewerId) {
    throw new Error(
      'security-stage work requires evidence.securityReviewerId to leave security-checking',
    );
  }
  if (securityReviewerId === attempt.implementerId) {
    throw new Error('securityReviewerId must differ from implementerId');
  }
}

function mergeEvidence(attempt, nextState, evidence) {
  // red / verification / security are never written here; verify run owns those fields.
  if (evidence.changedFiles) attempt.evidence.changedFiles = evidence.changedFiles;
  if (evidence.baseRev) attempt.evidence.baseRev = evidence.baseRev;
  if (evidence.implementerId) attempt.implementerId = evidence.implementerId;
}
