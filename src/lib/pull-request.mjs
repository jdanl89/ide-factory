import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getAttempt } from './attempt.mjs';
import {
  buildCommentPullRequestArgv,
  buildCreatePullRequestArgv,
  buildListCommentsArgv,
  buildUpdatePullRequestArgv,
  runForge,
} from './forge.mjs';
import { halted, writeText } from './layout.mjs';

const CHANGE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Open or update the single pull request for an OpenSpec change.
 * @param {string} project
 * @param {string} change
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ record: object, created: boolean }}
 */
export function openPullRequest(project, change, env = process.env) {
  if (halted(project)) {
    throw new Error('HALT file present. Factory commands are stopped. Remove it with idefactory resume.');
  }
  const name = String(change || '').trim();
  if (!CHANGE_NAME.test(name)) {
    throw new Error('Usage: idefactory pr open <change>');
  }

  const branch = `factory/${name}`;
  const existing = readPullRequestRecord(project, name);
  const body = buildPullRequestBody(project, name);
  const bodyDigest = digestBody(body);

  if (!existing) {
    ensureBranch(project, branch);
    const argv = buildCreatePullRequestArgv({
      branch,
      title: name,
      body,
    });
    assertSafeForgeArgv(argv);
    const result = runForge(project, argv, env);
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `forge exited ${result.status}`);
    }
    const url = parseCreatedPullRequestUrl(result.stdout);
    const number = Number(url.split('/').at(-1));
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error('forge create returned an invalid pull request URL');
    }
    const record = {
      change: name,
      branch,
      pullRequest: {
        number,
        url,
      },
      bodyDigest,
      postedVerdicts: [],
      capturedComments: [],
    };
    writePullRequestRecord(project, record);
    return { record, created: true };
  }

  const argv = buildUpdatePullRequestArgv({
    number: existing.pullRequest.number,
    body,
  });
  assertSafeForgeArgv(argv);
  const result = runForge(project, argv, env);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `forge exited ${result.status}`);
  }
  const record = {
    ...existing,
    change: name,
    branch: existing.branch || branch,
    bodyDigest,
    postedVerdicts: Array.isArray(existing.postedVerdicts) ? existing.postedVerdicts : [],
    capturedComments: Array.isArray(existing.capturedComments) ? existing.capturedComments : [],
  };
  writePullRequestRecord(project, record);
  return { record, created: false };
}

/**
 * Post the verdict already stored on an attempt. Does not create a verdict.
 * @param {string} project
 * @param {string} attemptId
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ record: object }}
 */
export function commentOnPullRequest(project, attemptId, env = process.env) {
  if (halted(project)) {
    throw new Error('HALT file present. Factory commands are stopped. Remove it with idefactory resume.');
  }
  const id = String(attemptId || '').trim();
  if (!id) throw new Error('Usage: idefactory pr comment <attemptId>');
  const attempt = getAttempt(project, id);
  if (!attempt) throw new Error(`Attempt not found: ${id}`);

  const review = attempt.evidence?.review;
  const verdict = typeof review?.verdict === 'string' ? review.verdict.trim() : '';
  const role = typeof review?.role === 'string' ? review.role.trim() : '';
  if (!verdict || !role) {
    throw new Error('pr comment requires a verdict and role already stored on the attempt');
  }

  const reviewerId = review.reviewerId || attempt.reviewerId;
  return postVerdictComment(project, {
    attemptId: attempt.id,
    verdict,
    role,
    reviewerId: typeof reviewerId === 'string' ? reviewerId : null,
  }, env);
}

/**
 * Post one already-stored verdict through the forge port.
 * Does not read or write evidence.review.
 * @param {string} project
 * @param {{ attemptId: string, verdict: string, role: string, reviewerId?: string|null }} stored
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ record: object }}
 */
export function postVerdictComment(project, stored, env = process.env) {
  const attempt = getAttempt(project, stored.attemptId);
  if (!attempt) throw new Error(`Attempt not found: ${stored.attemptId}`);
  const record = readPullRequestRecord(project, attempt.change);
  if (!record) {
    throw new Error(`No pull request record for ${attempt.change}`);
  }

  const postedVerdicts = Array.isArray(record.postedVerdicts) ? record.postedVerdicts : [];
  const alreadyPosted = postedVerdicts.some(
    (item) => item?.attemptId === attempt.id && item?.role === stored.role,
  );
  if (alreadyPosted) return { record };

  const lines = [
    `Role: ${stored.role}`,
    `Verdict: ${stored.verdict}`,
    `Attempt: ${attempt.id}`,
  ];
  if (typeof stored.reviewerId === 'string' && stored.reviewerId.length > 0) {
    lines.push(`Reviewer: ${stored.reviewerId}`);
  }
  const body = `${lines.join('\n')}\n`;
  const argv = buildCommentPullRequestArgv({
    number: record.pullRequest.number,
    body,
  });
  assertSafeForgeArgv(argv);
  const result = runForge(project, argv, env);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `forge exited ${result.status}`);
  }

  const posted = {
    attemptId: attempt.id,
    verdict: stored.verdict,
    role: stored.role,
    reviewerId: stored.reviewerId || null,
  };
  const next = {
    ...record,
    postedVerdicts: [...postedVerdicts, posted],
    capturedComments: Array.isArray(record.capturedComments) ? record.capturedComments : [],
  };
  writePullRequestRecord(project, next);
  return { record: next };
}

/**
 * Store human pull request comments once, keyed by forge comment id.
 * Does not authorize accept or complete.
 * @param {string} project
 * @param {string} change
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ record: object }}
 */
export function capturePullRequestComments(project, change, env = process.env) {
  if (halted(project)) {
    throw new Error('HALT file present. Factory commands are stopped. Remove it with idefactory resume.');
  }
  const name = String(change || '').trim();
  if (!CHANGE_NAME.test(name)) {
    throw new Error('Usage: idefactory pr capture <change>');
  }
  const record = readPullRequestRecord(project, name);
  if (!record) {
    throw new Error(`No pull request record for ${name}`);
  }

  const argv = buildListCommentsArgv({ number: record.pullRequest.number });
  assertSafeForgeArgv(argv);
  const result = runForge(project, argv, env);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `forge exited ${result.status}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error('forge comment list returned invalid JSON');
  }
  const incoming = Array.isArray(parsed?.comments) ? parsed.comments : [];
  const captured = Array.isArray(record.capturedComments) ? [...record.capturedComments] : [];
  const seen = new Set(captured.map((item) => String(item.id)));
  for (const raw of incoming) {
    const comment = normalizeCapturedComment(raw);
    if (!comment || seen.has(comment.id)) continue;
    captured.push(comment);
    seen.add(comment.id);
  }
  const next = {
    ...record,
    postedVerdicts: Array.isArray(record.postedVerdicts) ? record.postedVerdicts : [],
    capturedComments: captured,
  };
  writePullRequestRecord(project, next);
  return { record: next };
}

function normalizeCapturedComment(raw) {
  if (!raw || raw.id === undefined || raw.id === null) return null;
  const id = String(raw.id).trim();
  if (!id) return null;
  let author = '';
  if (typeof raw.author === 'string') author = raw.author;
  else if (raw.author && typeof raw.author.login === 'string') author = raw.author.login;
  const url = typeof raw.url === 'string' ? raw.url : '';
  const time = typeof raw.createdAt === 'string'
    ? raw.createdAt
    : (typeof raw.time === 'string' ? raw.time : '');
  const body = typeof raw.body === 'string' ? raw.body : '';
  return { id, author, url, time, body };
}

/**
 * @param {string} project
 * @param {string} change
 * @returns {string}
 */
export function pullRequestRecordPath(project, change) {
  return path.join(project, '.factory', 'pull-requests', `${change}.json`);
}

/**
 * @param {string} project
 * @param {string} change
 * @returns {object|null}
 */
export function readPullRequestRecord(project, change) {
  const file = pullRequestRecordPath(project, change);
  if (!fs.existsSync(file)) return null;
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!record || record.change !== change) return null;
    if (!record.pullRequest || !Number.isInteger(record.pullRequest.number)) return null;
    return record;
  } catch {
    return null;
  }
}

/**
 * A change is deliverable only when pr open wrote a factory-branch record
 * that names a positive pull request number and a non-empty URL.
 * @param {string} project
 * @param {string} change
 * @returns {boolean}
 */
export function isDeliverableChange(project, change) {
  const record = readPullRequestRecord(project, change);
  if (!record) return false;
  if (record.branch !== `factory/${change}`) return false;
  const number = record.pullRequest?.number;
  const url = record.pullRequest?.url;
  if (!Number.isInteger(number) || number <= 0) return false;
  if (typeof url !== 'string' || url.length === 0) return false;
  return true;
}

/**
 * Stage 1 exit record check. The result follows isDeliverableChange.
 * @param {string} project
 * @param {string} change
 * @returns {{ change: string, result: 'pass' | 'fail' }}
 */
export function stage1ExitRecordCheck(project, change) {
  return {
    change,
    result: isDeliverableChange(project, change) ? 'pass' : 'fail',
  };
}

function writePullRequestRecord(project, record) {
  writeText(pullRequestRecordPath(project, record.change), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Build a pull request body that links factory evidence without copying logs
 * or environment values.
 * @param {string} project
 * @param {string} change
 * @returns {string}
 */
export function buildPullRequestBody(project, change) {
  const sourceRevision = resolveSourceRevision(project, change);
  const attempts = listAttemptsForChange(project, change);
  const lines = [
    `# ${change}`,
    '',
    `Change: ${change}`,
    `Source revision: ${sourceRevision || '(unknown)'}`,
    '',
    'Attempts:',
  ];
  if (attempts.length === 0) {
    lines.push('- (none recorded)');
  } else {
    for (const attempt of attempts) {
      const rel = `.factory/attempts/${attempt.id}.json`;
      lines.push(`- \`${attempt.id}\` (\`${rel}\`)`);
    }
  }

  const approvalPaths = listExistingApprovalPaths(project);
  lines.push('', 'Approvals:');
  if (approvalPaths.length === 0) {
    lines.push('- (none)');
  } else {
    for (const rel of approvalPaths) {
      lines.push(`- \`${rel}\``);
    }
  }

  const checkRecordPaths = attempts.map((attempt) => `.factory/attempts/${attempt.id}.json`);
  lines.push('', 'Check records:');
  if (checkRecordPaths.length === 0) {
    lines.push('- (none)');
  } else {
    for (const rel of checkRecordPaths) {
      lines.push(`- \`${rel}\``);
    }
  }

  return `${lines.join('\n')}\n`;
}

function resolveSourceRevision(project, change) {
  const fromGit = gitHead(project);
  if (fromGit) return fromGit;
  const attempts = listAttemptsForChange(project, change);
  for (const attempt of attempts) {
    for (const record of attempt.evidence?.verification || []) {
      if (typeof record?.sourceRevision === 'string' && record.sourceRevision.length > 0) {
        return record.sourceRevision;
      }
    }
    if (typeof attempt.evidence?.red?.sourceRevision === 'string'
      && attempt.evidence.red.sourceRevision.length > 0) {
      return attempt.evidence.red.sourceRevision;
    }
    const reds = attempt.evidence?.reds;
    if (reds && typeof reds === 'object') {
      for (const record of Object.values(reds)) {
        if (typeof record?.sourceRevision === 'string' && record.sourceRevision.length > 0) {
          return record.sourceRevision;
        }
      }
    }
  }
  return '';
}

function listAttemptsForChange(project, change) {
  const root = path.join(project, '.factory', 'attempts');
  if (!fs.existsSync(root)) return [];
  const attempts = [];
  for (const name of fs.readdirSync(root)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(root, name);
    try {
      const attempt = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (attempt?.change === change && typeof attempt.id === 'string') {
        attempts.push(attempt);
      }
    } catch {
      // Skip unreadable attempt files.
    }
  }
  attempts.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return attempts;
}

function listExistingApprovalPaths(project) {
  const root = path.join(project, '.factory', 'approvals');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => `.factory/approvals/${name}`);
}

function gitHead(project) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: project,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) return '';
  return (result.stdout || '').trim();
}

function digestBody(body) {
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

function ensureBranch(project, branch) {
  const existing = spawnSync('git', ['rev-parse', '--verify', branch], {
    cwd: project,
    encoding: 'utf8',
    shell: false,
  });
  if (existing.status === 0) return;
  const created = spawnSync('git', ['branch', branch, 'HEAD'], {
    cwd: project,
    encoding: 'utf8',
    shell: false,
  });
  if (created.status !== 0) {
    throw new Error(created.stderr.trim() || `failed to create branch ${branch}`);
  }
}

function assertSafeForgeArgv(argv) {
  const joined = argv.join(' ');
  if (/\bmerge\b/i.test(joined)) {
    throw new Error('forge argv must not merge');
  }
  if (/\brulesets\b/i.test(joined) || /branches\/.+\/protection/i.test(joined)
    || /api\.github\.com/i.test(joined)) {
    throw new Error('forge argv must not call the forge admin API');
  }
}

function parseCreatedPullRequestUrl(stdout) {
  const url = String(stdout || '').trim();
  if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/[1-9]\d*$/.test(url)) {
    throw new Error('forge create did not return a pull request URL');
  }
  return url;
}
