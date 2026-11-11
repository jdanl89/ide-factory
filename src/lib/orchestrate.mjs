import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { attemptPath, getAttempt, startAttempt, transitionAttempt } from './attempt.mjs';
import {
  canResumeFinalization,
  finalizationJournalPath,
  readFinalizationJournal,
} from './finalization-recovery.mjs';
import { hasActiveLockout } from './govern.mjs';
import { appendControlEvent } from './event-log.mjs';
import { halted, ledger, readText, writeText } from './layout.mjs';
import { syncTasks } from './queue.mjs';
import {
  checkHostUsageBudgets,
  InvalidBudgetError,
  openOrResumeRunSession,
  parseExposedHostMetric,
  refreshCompletedTasks,
  refreshFailures,
  resolveNewSessionBudgets,
  STICKY_STOP_REASONS,
  writeRunSession,
} from './run-session.mjs';
import { classifyCheckOutcome, isRequiredTestKind, retryKey } from './red-evidence.mjs';
import { humanGateAllows } from './risk-gates.mjs';
import { resolveGitBinding, validateCheckRegistry } from './verification-evidence.mjs';
import { getWorkItem, listWorkItems, selectReady, workCounts } from './work.mjs';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_NEEDS_AGENT = 2;

export function runFactory(project, env, {
  change,
  until = 'human-gate',
  maxTasks,
  maxAgentSteps,
  maxTokens,
  maxCost,
  hostTokens,
  hostCost,
  newRun = false,
  acceptBaseline = false,
} = {}) {
  if (halted(project)) {
    const error = new Error('HALT file present. Factory commands are stopped. Remove it with idefactory resume.');
    error.code = 'HALT';
    throw error;
  }
  if (!change) throw new Error('Usage: idefactory run --change <name>');
  if (hasActiveLockout(project)) {
    return {
      code: EXIT_ERROR,
      text: 'Active lockout present. Resolve before run.\n',
      stopReason: 'lockout',
    };
  }

  const config = readConfig(project);
  let sessionBudgets;
  let hostUsage;
  try {
    sessionBudgets = resolveNewSessionBudgets(config, {
      maxTasks,
      maxAgentSteps,
      maxTokens,
      maxCost,
    });
    hostUsage = {
      hostTokens: parseExposedHostMetric(hostTokens, env.IDEFACTORY_HOST_TOKENS, {
        label: 'host-tokens',
        integer: true,
      }),
      hostCost: parseExposedHostMetric(hostCost, env.IDEFACTORY_HOST_COST, {
        label: 'host-cost',
        integer: false,
      }),
    };
  } catch (err) {
    if (err instanceof InvalidBudgetError) {
      return {
        code: EXIT_ERROR,
        text: `Run stopped (invalid-budget) for ${change}.\n`,
        stopReason: 'invalid-budget',
        request: null,
      };
    }
    throw err;
  }
  const now = new Date();
  let session = openOrResumeRunSession(project, {
    change,
    budgets: sessionBudgets,
    now,
    newRun,
    resumeFlags: { maxTasks, maxAgentSteps },
    config,
  });
  if (session.status === 'closed' && STICKY_STOP_REASONS.has(session.stopReason)) {
    return {
      code: EXIT_OK,
      text: `Run stopped (${session.stopReason}) for ${change}.\n`,
      stopReason: session.stopReason,
      request: null,
    };
  }
  if (session.status === 'closed' && (session.stopReason === 'infrastructure-failure' || session.stopReason === 'baseline')) {
    session = writeRunSession(project, {
      ...session,
      status: 'open',
      stopReason: null,
      lastObservedAt: new Date().toISOString(),
    });
  }
  const hostStop = checkHostUsageBudgets(session, hostUsage);
  if (hostStop) {
    session = closeRunSession(project, session, hostStop.stopReason, hostStop.patch);
    return {
      code: hostStop.code,
      text: `Run stopped (${hostStop.stopReason}) for ${change}.\n`,
      stopReason: hostStop.stopReason,
      request: null,
    };
  }
  const startedMs = Date.parse(session.startedAt);
  const nowMs = now.getTime();
  if (Number.isFinite(startedMs) && nowMs < startedMs) {
    session = closeRunSession(project, session, 'invalid-session');
    return {
      code: EXIT_ERROR,
      text: `Run stopped (invalid-session) for ${change}.\n`,
      stopReason: 'invalid-session',
      request: null,
    };
  }
  if (Number.isFinite(startedMs) && nowMs - startedMs >= session.budgets.maxWallClockMs) {
    session = closeRunSession(project, session, 'wall-clock');
    return {
      code: EXIT_OK,
      text: `Run stopped (wall-clock) for ${change}.\n`,
      stopReason: 'wall-clock',
      request: null,
    };
  }
  if (session.agentSteps >= session.budgets.maxAgentSteps) {
    session = closeRunSession(project, session, 'max-agent-steps');
    return {
      code: EXIT_OK,
      text: `Run stopped (max-agent-steps) for ${change}.\n`,
      stopReason: 'max-agent-steps',
      request: null,
    };
  }

  syncTasks(project, change, env);
  session = refreshCompletedTasks(project, session);
  if (session.completedTasks >= session.budgets.maxTasks) {
    session = closeRunSession(project, session, 'max-tasks');
    return {
      code: EXIT_OK,
      text: `Run stopped (max-tasks) for ${change}.\n`,
      stopReason: 'max-tasks',
      request: null,
    };
  }
  session = refreshFailures(project, session);
  if (session.failureCount >= session.budgets.maxFailures) {
    session = closeRunSession(project, session, 'max-failures');
    return {
      code: EXIT_OK,
      text: `Run stopped (max-failures) for ${change}.\n`,
      stopReason: 'max-failures',
      request: null,
    };
  }

  const limit = session.budgets.maxTasks;
  let progressed = 0;

  while (progressed < limit) {
    const counts = workCounts(project, change);
    if (counts.todo === 0 && counts.in_progress === 0) {
      ledger(project, 'run-complete', { change, reason: 'all-done' });
      return {
        code: EXIT_OK,
        text: `Run complete for ${change}: all work items done.\n`,
        stopReason: 'all-done',
      };
    }

    const inProgress = listWorkItems(project, change).find((item) => item.status === 'in_progress');
    let item = inProgress || selectReady(project, change);
    if (!item) {
      return {
        code: EXIT_ERROR,
        text: `No ready work items for ${change}. Remaining todos may be blocked by dependencies.\n`,
        stopReason: 'blocked',
      };
    }

    let attempt = item.attemptId ? getAttempt(project, item.attemptId) : null;
    if (!attempt) {
      const role = primaryRole(item);
      const modelProfile = item.factory?.modelProfile || profileForRole(config, role);
      attempt = startAttempt(project, change, item.id, { role, modelProfile });
      item = getWorkItem(project, change, item.id);
    }

    if (attempt.state === 'rejected') {
      return {
        code: EXIT_ERROR,
        text: renderStop('rejected', attempt, item),
        stopReason: 'rejected',
        request: null,
      };
    }

    if (attempt.state === 'accepted' || needsCompleteForUnfinishedJournal(project, attempt, item)) {
      const fingerprint = {
        action: 'complete',
        role: 'scribe',
        taskId: item.id,
        attemptId: attempt.id,
        attemptState: attempt.state,
        workItemStatus: item.status,
      };
      if (fingerprintsEqual(session.lastRequestFingerprint, fingerprint)) {
        session = closeRunSession(project, session, 'unchanged-state');
        return {
          code: EXIT_OK,
          text: `Run stopped (unchanged-state) for ${change}.\n`,
          stopReason: 'unchanged-state',
          request: null,
        };
      }
      session = persistCompleteBeforeRequest(project, session, fingerprint);
      const message = attempt.state === 'accepted'
        ? 'Attempt accepted. Run idefactory complete to finalize.'
        : 'Finalization journal unfinished. Run idefactory complete to resume.';
      return {
        code: EXIT_NEEDS_AGENT,
        text: renderRequest({
          action: 'complete',
          role: 'scribe',
          item,
          attempt,
          modelProfile: profileForRole(config, 'scribe'),
          message,
        }),
        stopReason: 'needs-complete',
        request: { action: 'complete', change, taskId: item.id, attemptId: attempt.id },
      };
    }

    const stage = stageForState(attempt.state, item);
    if (stage.needsAgent) {
      if (
        stage.nextState === 'accepted'
        && !humanGateAllows(project, {
          action: 'accept',
          verificationProfile: item.factory?.verificationProfile,
          change: attempt.change || change,
          task: item.id,
          implementerId: attempt.implementerId,
        })
      ) {
        return {
          code: EXIT_OK,
          text: renderStop('human-gate', attempt, item),
          stopReason: 'human-gate',
          request: null,
        };
      }
      if (session.agentSteps >= session.budgets.maxAgentSteps) {
        session = closeRunSession(project, session, 'max-agent-steps');
        return {
          code: EXIT_OK,
          text: `Run stopped (max-agent-steps) for ${change}.\n`,
          stopReason: 'max-agent-steps',
          request: null,
        };
      }
      if ((attempt.state === 'planned' || attempt.state === 'assigned') && stage.nextState === 'implementing') {
        const baseline = applyTestBaseline(project, session, attempt, { acceptBaseline });
        session = baseline.session;
        if (baseline.stop) {
          session = closeRunSession(project, session, baseline.stop);
          const extra = baseline.stop === 'infrastructure-failure'
            ? 'Run idefactory setup to map a test command.\n'
            : '';
          return {
            code: EXIT_OK,
            text: `Run stopped (${baseline.stop}) for ${change}.\n${extra}`,
            stopReason: baseline.stop,
            request: null,
          };
        }
      }
      const request = {
        action: 'agent-step',
        role: stage.role,
        change,
        taskId: item.id,
        attemptId: attempt.id,
        state: attempt.state,
        nextState: stage.nextState,
        modelProfile: item.factory?.modelProfile || profileForRole(config, stage.role),
        charter: `.factory/agents/${stage.role}/charter.md`,
        history: `.factory/agents/${stage.role}/history.md`,
        checks: item.factory?.checks || [],
        verificationProfile: item.factory?.verificationProfile,
      };
      const fingerprint = {
        action: 'agent-step',
        role: stage.role,
        taskId: item.id,
        attemptId: attempt.id,
        attemptState: attempt.state,
        workItemStatus: item.status,
      };
      if (fingerprintsEqual(session.lastRequestFingerprint, fingerprint)) {
        session = closeRunSession(project, session, 'unchanged-state');
        return {
          code: EXIT_OK,
          text: `Run stopped (unchanged-state) for ${change}.\n`,
          stopReason: 'unchanged-state',
          request: null,
        };
      }
      session = persistAgentStepBeforeRequest(project, session, {
        action: 'agent-step',
        role: stage.role,
        taskId: item.id,
        attemptId: attempt.id,
        attemptState: attempt.state,
        workItemStatus: item.status,
      });
      ledger(project, 'run-needs-agent', { change, taskId: item.id, role: stage.role, state: attempt.state });
      return {
        code: EXIT_NEEDS_AGENT,
        text: renderRequest({ ...request, item, attempt, message: stage.message }),
        stopReason: 'needs-agent',
        request,
      };
    }

    // Pure file advances are limited; if we cannot advance, stop.
    progressed += 1;
  }

  return {
    code: EXIT_OK,
    text: `Stopped after max-tasks=${limit} for ${change}.\n`,
    stopReason: 'max-tasks',
  };
}

function needsCompleteForUnfinishedJournal(project, attempt, item) {
  if (!attempt || !item || item.status === 'done') return false;
  if (attempt.state !== 'finalized' && attempt.state !== 'finalize-failed') return false;
  const file = finalizationJournalPath(project, attempt.id);
  if (!fs.existsSync(file)) return false;
  try {
    const journal = readFinalizationJournal(project, attempt.id, {
      change: attempt.change,
      taskId: attempt.taskId,
      attemptId: attempt.id,
    });
    return canResumeFinalization(attempt, item, journal);
  } catch {
    return false;
  }
}

function fingerprintsEqual(a, b) {
  if (!a || !b) return false;
  return a.action === b.action
    && a.role === b.role
    && a.taskId === b.taskId
    && a.attemptId === b.attemptId
    && a.attemptState === b.attemptState
    && a.workItemStatus === b.workItemStatus;
}

function persistAgentStepBeforeRequest(project, session, fingerprint) {
  const written = writeRunSession(project, {
    ...session,
    agentSteps: session.agentSteps + 1,
    lastObservedAt: new Date().toISOString(),
    lastRequestFingerprint: fingerprint,
  });
  // Best-effort: ledger() must not block a valid session write.
  ledger(project, 'run-agent-step', {
    change: written.change,
    runId: written.runId,
    agentSteps: written.agentSteps,
  });
  return written;
}

function persistCompleteBeforeRequest(project, session, fingerprint) {
  return writeRunSession(project, {
    ...session,
    lastObservedAt: new Date().toISOString(),
    lastRequestFingerprint: fingerprint,
  });
}

function closeRunSession(project, session, stopReason, extra = {}) {
  const written = writeRunSession(project, {
    ...session,
    ...extra,
    status: 'closed',
    stopReason,
    lastObservedAt: new Date().toISOString(),
  });
  appendControlEvent(project, {
    type: 'run.stopped',
    time: written.lastObservedAt,
    runId: written.runId,
    change: written.change,
    stopReason,
  });
  return written;
}

function stageForState(state, item) {
  const roles = item.factory?.roles || ['engineer', 'reviewer', 'scribe'];
  const implementer = item.factory?.route === 'quick'
    ? 'engineer'
    : roles.find((role) => !['reviewer', 'scribe', 'security-reviewer'].includes(role))
      || 'engineer';
  switch (state) {
    case 'planned':
    case 'assigned':
      return {
        needsAgent: true,
        role: implementer,
        nextState: 'implementing',
        message: 'Begin implementation. Record implementerId, then transition to implementing / red-confirmed.',
      };
    case 'implementing':
      if (item.factory?.taskType === 'lightweight') {
        return {
          needsAgent: true,
          role: implementer,
          nextState: 'verifying',
          message: 'Lightweight item. Implement and run verification. A failing test is not required.',
        };
      }
      return {
        needsAgent: true,
        role: implementer,
        nextState: 'red-confirmed',
        message: 'Write a failing test and report red evidence with idefactory verify run --red.',
      };
    case 'red-confirmed':
      return {
        needsAgent: true,
        role: implementer,
        nextState: 'verifying',
        message: 'Implement until green and run verification profile checks.',
      };
    case 'verifying': {
      const needsSecurity = (item.factory?.securityProfile === 'security-sensitive')
        || (item.factory?.checks || []).some((check) => /security|sast|threat|secret|audit/i.test(check));
      if (needsSecurity) {
        return {
          needsAgent: true,
          role: 'security-reviewer',
          nextState: 'security-checking',
          message: 'Run security profile checks and record security evidence.',
        };
      }
      return {
        needsAgent: true,
        role: 'reviewer',
        nextState: 'awaiting-review',
        message: 'Hand off for review with verification evidence recorded.',
      };
    }
    case 'security-checking':
      return {
        needsAgent: true,
        role: 'reviewer',
        nextState: 'awaiting-review',
        message: 'Security evidence recorded. Reviewer reviews the change.',
      };
    case 'awaiting-review':
      return {
        needsAgent: true,
        role: 'reviewer',
        nextState: 'accepted',
        message: 'Reviewer returns ACCEPT or REJECT with reviewerId different from implementer.',
      };
    default:
      return { needsAgent: false };
  }
}

function primaryRole(item) {
  if (item.factory?.route === 'quick') return 'engineer';
  const roles = item.factory?.roles || ['engineer'];
  return roles.find((role) => !['reviewer', 'scribe'].includes(role)) || 'engineer';
}

function profileForRole(config, role) {
  return config.roles?.[role]?.modelProfile
    || config.modelProfiles && 'coding-standard'
    || 'coding-standard';
}

function renderRequest(request) {
  const lines = [
    '# Orchestration request',
    '',
    `Action: ${request.action}`,
    `Role: ${request.role}`,
    `Model profile: ${request.modelProfile || 'coding-standard'}`,
    `Change: ${request.change || request.item?.change}`,
    `Work item: ${request.taskId || request.item?.id}`,
    `Attempt: ${request.attemptId || request.attempt?.id}`,
    `State: ${request.state || request.attempt?.state || ''}`,
    `Next state: ${request.nextState || ''}`,
    `Charter: ${request.charter || `.factory/agents/${request.role}/charter.md`}`,
    `History: ${request.history || `.factory/agents/${request.role}/history.md`}`,
    '',
    request.message || '',
    '',
    '```json',
    JSON.stringify({
      action: request.action,
      role: request.role,
      change: request.change || request.item?.change,
      taskId: request.taskId || request.item?.id,
      attemptId: request.attemptId || request.attempt?.id,
      state: request.state || request.attempt?.state,
      nextState: request.nextState,
      modelProfile: request.modelProfile,
      checks: request.checks,
      verificationProfile: request.verificationProfile,
    }, null, 2),
    '```',
    '',
    'The IDE session model does the work. Do not start a model process from the CLI.',
    '',
  ];
  return lines.join('\n');
}

function renderStop(reason, attempt, item) {
  return [
    `# Run stopped (${reason})`,
    '',
    `Change: ${item.change}`,
    `Work item: ${item.id}`,
    `Attempt: ${attempt.id}`,
    `State: ${attempt.state}`,
    '',
  ].join('\n');
}

function readConfig(project) {
  const file = path.join(project, '.factory', 'config.json');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(readText(file));
  } catch {
    return {};
  }
}

function applyTestBaseline(project, session, attempt, { acceptBaseline }) {
  const mapped = mappedTestChecks(project);
  if (mapped.length === 0) return { session, stop: null };
  const { sourceRevision } = resolveGitBinding(project);
  const revision = sourceRevision || '';
  const current = session.testBaseline;
  if (
    current
    && current.sourceRevision === revision
    && (current.result === 'passed' || current.result === 'accepted')
  ) {
    return { session, stop: null };
  }

  for (const entry of mapped) {
    const classification = runMappedCheck(project, entry);
    if (classification === 'infrastructure-failure') {
      const count = bumpAttemptRetry(project, attempt, classification, entry.kind);
      return { session, stop: count >= 4 ? 'retry-cap' : 'infrastructure-failure' };
    }
    if (classification === 'assertion-failure') {
      if (acceptBaseline) {
        return {
          session: writeRunSession(project, {
            ...session,
            testBaseline: { sourceRevision: revision, result: 'accepted' },
          }),
          stop: null,
        };
      }
      return { session, stop: 'baseline' };
    }
  }

  return {
    session: writeRunSession(project, {
      ...session,
      testBaseline: { sourceRevision: revision, result: 'passed' },
    }),
    stop: null,
  };
}

function mappedTestChecks(project) {
  const registryPath = path.join(project, '.factory', 'checks.json');
  if (!fs.existsSync(registryPath)) return [];
  try {
    const registry = validateCheckRegistry(JSON.parse(readText(registryPath)), { projectRoot: project });
    return Object.entries(registry.checks)
      .filter(([kind]) => isRequiredTestKind(kind))
      .map(([kind, entry]) => ({ kind, ...entry }));
  } catch {
    return [];
  }
}

function runMappedCheck(project, entry) {
  const result = spawnSync(entry.argv[0], entry.argv.slice(1), {
    cwd: project,
    shell: false,
    timeout: entry.timeoutMs,
    encoding: 'buffer',
  });
  const timedOut = Boolean(result.error && result.error.code === 'ETIMEDOUT');
  const spawnError = result.error && !timedOut ? result.error : null;
  const stdout = result.stdout || Buffer.alloc(0);
  const stderr = result.stderr || Buffer.alloc(0);
  return classifyCheckOutcome({
    spawnError,
    timedOut,
    exitCode: typeof result.status === 'number' ? result.status : null,
    output: Buffer.concat([stdout, stderr]).toString('utf8'),
    asRed: false,
  });
}

function bumpAttemptRetry(project, attempt, classification, kind) {
  const fresh = getAttempt(project, attempt.id) || attempt;
  const key = retryKey(classification, kind);
  const counts = { ...(fresh.evidence?.retryCounts || {}) };
  counts[key] = (counts[key] || 0) + 1;
  fresh.evidence = fresh.evidence || {};
  fresh.evidence.retryCounts = counts;
  fresh.updatedAt = new Date().toISOString();
  writeText(attemptPath(project, fresh.id), JSON.stringify(fresh, null, 2));
  return counts[key];
}

export { getWorkItem, transitionAttempt };
