import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { attemptsRoot, getAttempt } from './attempt.mjs';
import { classifyTask, defaultAcceptanceCriteria, parseFactoryBlock } from './classify.mjs';
import { halted, ledger, readText, writeText } from './layout.mjs';
import {
  ensureWorkDirs,
  getWorkItem,
  itemPath,
  listWorkItems,
  selectReady,
  upsertWorkItem,
} from './work.mjs';

export function parseChangeRoute(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  for (const line of lines) {
    if (/^- \[[^\]]*\]/.test(line)) return null;
    const match = line.match(/^factory-route:\s*(\S+)\s*$/);
    if (!match) continue;
    if (match[1] !== 'quick' && match[1] !== 'full') {
      throw new Error(`factory-route must be quick or full, got ${match[1]}`);
    }
    return match[1];
  }
  return null;
}

export function parseCheckboxes(markdown) {
  const tasks = [];
  const pattern = /^- \[([^\]]*)\]\s+(\d+(?:\.\d+)+)\s+(.+)$/gm;
  let match = pattern.exec(markdown);
  while (match) {
    const mark = match[1].trim().toLowerCase();
    tasks.push({
      done: mark === 'x',
      id: match[2],
      title: match[3].trim(),
    });
    match = pattern.exec(markdown);
  }
  return tasks;
}

export function normalizeTaskText(title) {
  return String(title || '').trim().replace(/\s+/g, ' ');
}

export function provenanceForTitle(title) {
  const text = normalizeTaskText(title);
  return {
    algorithm: 'sha256',
    text,
    digest: createHash('sha256').update(text, 'utf8').digest('hex'),
  };
}

export function loadChangeTasks(project, change) {
  assertChangeName(change);
  const file = path.join(project, 'openspec', 'changes', change, 'tasks.md');
  if (!fs.existsSync(file)) {
    throw new Error(`OpenSpec change not found: openspec/changes/${change}/tasks.md`);
  }
  const markdown = fs.readFileSync(file, 'utf8');
  const changeRoute = parseChangeRoute(markdown);
  return parseCheckboxes(markdown).map((task) => {
    const { factory, acceptanceCriteria } = parseFactoryBlock(markdown, task.id);
    return { ...task, factory, acceptanceCriteria, markdown, changeRoute };
  });
}

export function syncTasks(project, change, _env) {
  if (halted(project)) throw haltError();
  ensureWorkDirs(project);
  const tasks = loadChangeTasks(project, change);
  const suggestions = [];
  for (const task of tasks) {
    classifyTask({
      id: task.id,
      title: task.title,
      body: task.title,
      factory: task.factory,
      routeDefault: task.changeRoute,
    });
    if (!task.factory?.route && !task.changeRoute && /\b(fix|bug|hotfix|bugfix)\b/i.test(task.title)) {
      suggestions.push('suggested route: quick');
    }
  }
  const existing = listWorkItems(project, change);

  if (existing.length === 0) {
    return { ...createInitialItems(project, change, tasks), suggestions };
  }

  return { ...reconcileExistingItems(project, change, tasks, existing), suggestions };
}

function createInitialItems(project, change, tasks) {
  let created = 0;
  let skipped = 0;
  for (const task of tasks) {
    if (task.done) {
      skipped += 1;
      continue;
    }
    writeNewWorkItem(project, change, task);
    created += 1;
  }
  return finishSync(project, change, created, skipped);
}

function reconcileExistingItems(project, change, tasks, existing) {
  const currentIds = tasks.map((task) => task.id);
  const previousIds = existing.map((item) => item.id);
  const currentIdSet = new Set(currentIds);
  const previousIdSet = new Set(previousIds);

  if (hasDuplicateNormalizedTitles(tasks.map((task) => task.title))
    || hasDuplicateNormalizedTitles(existing.map((item) => itemNormalizedText(item)))) {
    throw reconciliationError(change, previousIds, currentIds);
  }

  const sameIdSet = currentIdSet.size === previousIdSet.size
    && [...currentIdSet].every((id) => previousIdSet.has(id));

  if (sameIdSet) {
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const itemById = new Map(existing.map((item) => [item.id, item]));
    const allTextEqual = [...currentIdSet].every((id) => (
      normalizeTaskText(taskById.get(id).title) === itemNormalizedText(itemById.get(id))
    ));

    if (allTextEqual) {
      return applyIdempotentSync(project, change, tasks, itemById);
    }
    return applyTitleUpdates(project, change, tasks, itemById);
  }

  const textMatch = oneToOneTextMatch(tasks, existing);
  if (textMatch) {
    return applyRenumbers(project, change, tasks, textMatch);
  }

  throw reconciliationError(change, unmatchedPreviousIds(tasks, existing), unmatchedCurrentIds(tasks, existing));
}

function applyIdempotentSync(project, change, tasks, itemById) {
  let created = 0;
  let skipped = 0;
  for (const task of tasks) {
    const item = itemById.get(task.id);
    const provenance = provenanceForTitle(task.title);
    const existingProv = item.provenance;
    const provenanceEqual = existingProv
      && existingProv.algorithm === provenance.algorithm
      && existingProv.text === provenance.text
      && existingProv.digest === provenance.digest;
    if (!provenanceEqual) {
      upsertWorkItem(project, {
        ...item,
        id: item.id,
        change,
        status: item.status,
        attemptId: item.attemptId,
        provenance,
      });
    }
    skipped += 1;
  }
  return finishSync(project, change, created, skipped);
}

function applyTitleUpdates(project, change, tasks, itemById) {
  let created = 0;
  let skipped = 0;
  for (const task of tasks) {
    const item = itemById.get(task.id);
    const classified = classifyTask({
      id: task.id,
      title: task.title,
      body: task.title,
      factory: task.factory,
      routeDefault: task.changeRoute,
    });
    upsertWorkItem(project, {
      ...item,
      id: item.id,
      change,
      title: task.title,
      status: item.status,
      attemptId: item.attemptId,
      dependencies: classified.dependencies,
      acceptanceCriteria: defaultAcceptanceCriteria(task.title, task.acceptanceCriteria),
      factory: classified,
      provenance: provenanceForTitle(task.title),
    });
    skipped += 1;
  }
  return finishSync(project, change, created, skipped);
}

function applyRenumbers(project, change, tasks, pairs) {
  const planned = pairs.map(({ task, item }) => ({
    ...item,
    id: task.id,
    change,
    title: task.title,
    status: item.status,
    attemptId: item.attemptId,
    factory: item.factory || {},
    acceptanceCriteria: Array.isArray(item.acceptanceCriteria) ? item.acceptanceCriteria : [],
    provenance: item.provenance || provenanceForTitle(task.title),
  }));

  // Replace the matched set atomically enough to avoid id-swap collisions.
  for (const item of listWorkItems(project, change)) {
    const file = itemPath(project, change, item.id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  for (const next of planned) {
    upsertWorkItem(project, next);
  }
  for (const { task, item } of pairs) {
    if (task.id !== item.id) {
      retargetAttempts(project, change, item.id, task.id);
    }
  }
  return finishSync(project, change, 0, tasks.length);
}

function writeNewWorkItem(project, change, task) {
  const classified = classifyTask({
    id: task.id,
    title: task.title,
    body: task.title,
    factory: task.factory,
    routeDefault: task.changeRoute,
  });
  upsertWorkItem(project, {
    id: task.id,
    change,
    title: task.title,
    status: 'todo',
    dependencies: classified.dependencies,
    acceptanceCriteria: defaultAcceptanceCriteria(task.title, task.acceptanceCriteria),
    factory: classified,
    attemptId: null,
    provenance: provenanceForTitle(task.title),
  });
}

function finishSync(project, change, created, skipped) {
  writeText(
    path.join(project, '.factory', 'active-change.json'),
    JSON.stringify({ change, updatedAt: new Date().toISOString() }, null, 2),
  );
  ledger(project, 'sync-tasks', { change, created, skipped });
  return { created, skipped, change };
}

function itemNormalizedText(item) {
  if (item?.provenance?.text != null) return normalizeTaskText(item.provenance.text);
  return normalizeTaskText(item?.title || '');
}

function hasDuplicateNormalizedTitles(titles) {
  const seen = new Set();
  for (const title of titles) {
    const key = normalizeTaskText(title);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function oneToOneTextMatch(tasks, existing) {
  const itemsByText = new Map();
  for (const item of existing) {
    const key = itemNormalizedText(item);
    if (itemsByText.has(key)) return null;
    itemsByText.set(key, item);
  }
  const taskTexts = new Set();
  const pairs = [];
  for (const task of tasks) {
    const key = normalizeTaskText(task.title);
    if (taskTexts.has(key)) return null;
    taskTexts.add(key);
    const item = itemsByText.get(key);
    if (!item) return null;
    pairs.push({ task, item });
  }
  if (taskTexts.size !== itemsByText.size) return null;
  return pairs;
}

function unmatchedPreviousIds(tasks, existing) {
  const currentTexts = new Set(tasks.map((task) => normalizeTaskText(task.title)));
  return existing
    .filter((item) => !currentTexts.has(itemNormalizedText(item)))
    .map((item) => item.id);
}

function unmatchedCurrentIds(tasks, existing) {
  const previousTexts = new Set(existing.map((item) => itemNormalizedText(item)));
  return tasks
    .filter((task) => !previousTexts.has(normalizeTaskText(task.title)))
    .map((task) => task.id);
}

function reconciliationError(change, previousIds, currentIds) {
  const prev = [...new Set(previousIds)].sort().join(', ') || '(none)';
  const curr = [...new Set(currentIds)].sort().join(', ') || '(none)';
  return new Error(
    `Reconciliation failed for change ${change}: `
    + `unmatched previous checkbox ids: ${prev}; `
    + `unmatched current checkbox ids: ${curr}`,
  );
}

function retargetAttempts(project, change, oldTaskId, newTaskId) {
  const root = attemptsRoot(project);
  if (!fs.existsSync(root)) return;
  for (const name of fs.readdirSync(root)) {
    if (!name.endsWith('.json')) continue;
    const attemptId = name.slice(0, -'.json'.length);
    const attempt = getAttempt(project, attemptId);
    if (!attempt || attempt.change !== change || attempt.taskId !== oldTaskId) continue;
    const next = {
      ...attempt,
      taskId: newTaskId,
      updatedAt: new Date().toISOString(),
    };
    writeText(path.join(root, name), JSON.stringify(next, null, 2));
  }
}

export function buildPacket(project, env, changeName) {
  if (halted(project)) throw haltError();
  const change = changeName || readActiveChange(project);
  const item = change
    ? selectReady(project, change) || listWorkItems(project, change).find((entry) => entry.status === 'todo')
    : selectAcrossChanges(project);
  if (!item) {
    return { empty: true, text: 'No ready To Do work item.\n' };
  }
  const config = readConfig(project);
  const role = primaryRole(item);
  const modelProfile = item.factory?.modelProfile || config.roles?.[role]?.modelProfile || 'coding-standard';
  const text = renderPacket({ role, item, modelProfile, project });
  ledger(project, 'next', { role, change: item.change, task: item.id });
  return { empty: false, text, role, task: item, item };
}

function selectAcrossChanges(project) {
  const items = listWorkItems(project);
  return items.find((item) => item.status === 'todo' && (!item.dependencies || !item.dependencies.length))
    || items.find((item) => item.status === 'todo')
    || null;
}

function renderPacket({ role, item, modelProfile, project }) {
  const criteria = (item.acceptanceCriteria || []).map((entry) => `- ${entry}`).join('\n');
  const roles = (item.factory?.roles || []).join(', ');
  const prior = priorRejectionBlock(project, item, role);
  return `# Work packet

Role: ${role}
Implementing agent: ${role}
Model profile: ${modelProfile}
Charter: .factory/agents/${role}/charter.md
History: .factory/agents/${role}/history.md

Read that charter and that history only. Do not read any other agent's charter.

Work item: ${item.change}/${item.id}
Title: ${item.title}
Status: ${item.status}
Change: ${item.change}
Roles pipeline: ${roles || role}
Verification profile: ${item.factory?.verificationProfile || '(default)'}
Checks: ${(item.factory?.checks || []).join(', ') || '(default)'}

Description:
openspec-task: ${item.id}

Change: openspec/changes/${item.change}/tasks.md

${item.title}

Acceptance criteria:
${criteria || '- (see the task)'}
${prior}
Method:
- Prefer common scaffolds and libraries over hand-rolled toolchains (for example npm create vite@latest for a SPA).
- Write a failing test before production code when the profile includes unit or equivalent checks.
- Record evidence on the attempt via idefactory attempt transition.
- Run verification profile checks before claiming done.
- Review is a different role: reviewer. The implementer does not approve their own work.
- Finalize with idefactory complete ${item.change} ${item.id} --attempt <id>.

The IDE session model does the work. Do not start a model process.
`;
}

function priorRejectionBlock(project, item, role) {
  if (!project || role === 'reviewer' || role === 'security-reviewer' || role === 'scribe') return '';
  const notes = priorRejections(project, item.change, item.id);
  if (notes.length === 0) return '';
  return `\nPrior rejections:\n${notes.join('\n')}\n`;
}

function priorRejections(project, change, taskId) {
  const root = attemptsRoot(project);
  if (!fs.existsSync(root)) return [];
  const rows = [];
  for (const name of fs.readdirSync(root)) {
    if (!name.endsWith('.json')) continue;
    const attempt = getAttempt(project, name.slice(0, -'.json'.length));
    if (!attempt || attempt.change !== change || attempt.taskId !== taskId || !attempt.id) continue;
    const reviewReject = attempt.state === 'rejected' || attempt.evidence?.review?.verdict === 'REJECT';
    const securityReject = attempt.evidence?.securityReview?.verdict === 'REJECT';
    if (!reviewReject && !securityReject) continue;
    rows.push(attempt);
  }
  rows.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const lines = [];
  for (const attempt of rows) {
    if (attempt.state === 'rejected' || attempt.evidence?.review?.verdict === 'REJECT') {
      lines.push(`- ${attempt.id}: ${attempt.evidence?.review?.notes || ''}`);
    }
    if (attempt.evidence?.securityReview?.verdict === 'REJECT') {
      const note = attempt.evidence.securityReview.notes || attempt.evidence.securityReview.verdict;
      lines.push(`- ${attempt.id} security review: ${note}`);
    }
  }
  return lines;
}

function primaryRole(item) {
  if (item.factory?.route === 'quick') return 'engineer';
  const roles = item.factory?.roles || [];
  if (roles.includes('architect')) return 'architect';
  const implementer = roles.find((role) => !['reviewer', 'scribe', 'security-reviewer', 'test-engineer'].includes(role));
  return implementer || 'engineer';
}

export function renderWorkPacket(project, item, role) {
  return renderPacket({
    role,
    item,
    modelProfile: 'coding-standard',
    project,
  });
}

function readActiveChange(project) {
  const file = path.join(project, '.factory', 'active-change.json');
  if (!fs.existsSync(file)) return '';
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).change || '';
  } catch {
    return '';
  }
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

function assertChangeName(change) {
  if (!change || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(change)) {
    throw new Error('Usage: idefactory sync-tasks <change-name>');
  }
}

function haltError() {
  const error = new Error('HALT file present. Factory commands are stopped. Remove it with idefactory resume.');
  error.code = 'HALT';
  return error;
}

export { haltError };
