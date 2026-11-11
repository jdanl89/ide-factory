import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseCheckboxes, renderWorkPacket } from '../src/lib/queue.mjs';
import { getWorkItem, listWorkItems } from '../src/lib/work.mjs';
import { cleanup, idefactory, repoRoot, tempProject } from './helpers.mjs';

test('parseCheckboxes treats an x mark as done', () => {
  const tasks = parseCheckboxes([
    '- [ ] 1.1 First',
    '- [x] 1.2 Second',
    '- [ x] 1.3 Third',
  ].join('\n'));
  assert.deepEqual(tasks.map((task) => [task.id, task.done]), [
    ['1.1', false],
    ['1.2', true],
    ['1.3', true],
  ]);
});

function writeDemoTasks(dir, body) {
  fs.mkdirSync(path.join(dir, 'openspec/changes/demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'openspec/changes/demo/tasks.md'), body);
}

function assertNoFactoryBacklogTaskList(dir) {
  const factoryDir = path.join(dir, '.factory');
  const names = fs.readdirSync(factoryDir);
  assert.equal(
    names.some((name) => name.toLowerCase() === 'backlog.md'),
    false,
    `.factory/ must not contain a backlog.md task list; found: ${names.join(', ')}`,
  );
  assert.equal(fs.existsSync(path.join(dir, 'Backlog.md')), false);
  assert.equal(fs.existsSync(path.join(dir, 'backlog.md')), false);
}

test('sync-tasks creates one work item per unchecked checkbox', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    writeDemoTasks(dir, [
      '# Tasks',
      '',
      '## 1. Work',
      '',
      '- [ ] 1.1 First unchecked task',
      '- [x] 1.2 Already done task',
      '- [ ] 1.3 Second unchecked task',
      '',
    ].join('\n'));
    const first = await idefactory(dir, ['sync-tasks', 'demo']);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /created 2/);
    const items = listWorkItems(dir, 'demo');
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((item) => item.id).sort(), ['1.1', '1.3']);
    assert.match(items[0].acceptanceCriteria[0], /First unchecked task|works as specified/i);
    assert.doesNotMatch(items[0].acceptanceCriteria.join('\n'), /Checkbox .* is implemented/);
  } finally {
    cleanup(dir);
  }
});

test('sync-tasks skips checked checkboxes', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    writeDemoTasks(dir, [
      '- [x] 1.1 Already done task',
      '- [ ] 1.2 Still open task',
      '',
    ].join('\n'));
    const result = await idefactory(dir, ['sync-tasks', 'demo']);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /created 1/);
    const items = listWorkItems(dir, 'demo');
    assert.equal(items.length, 1);
    assert.equal(items[0].id, '1.2');
    assert.equal(fs.existsSync(path.join(dir, '.factory/work/items/demo--1.1.json')), false);
  } finally {
    cleanup(dir);
  }
});

test('sync-tasks does not duplicate already synced checkboxes', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    writeDemoTasks(dir, [
      '- [ ] 1.1 First unchecked task',
      '- [ ] 1.3 Second unchecked task',
      '',
    ].join('\n'));
    const first = await idefactory(dir, ['sync-tasks', 'demo']);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /created 2/);
    const second = await idefactory(dir, ['sync-tasks', 'demo']);
    assert.equal(second.code, 0, second.err);
    assert.match(second.out, /created 0/);
    assert.equal(listWorkItems(dir, 'demo').length, 2);
    const itemFiles = fs.readdirSync(path.join(dir, '.factory/work/items'))
      .filter((name) => name.endsWith('.json'));
    assert.equal(itemFiles.length, 2);
  } finally {
    cleanup(dir);
  }
});

test('sync-tasks uses .factory/work as the only machine queue', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    writeDemoTasks(dir, '- [ ] 1.1 First unchecked task\n');
    const result = await idefactory(dir, ['sync-tasks', 'demo']);
    assert.equal(result.code, 0, result.err);
    assert.ok(
      fs.existsSync(path.join(dir, '.factory/work/items/demo--1.1.json')),
      'work item must exist under .factory/work/items',
    );
    assert.equal(listWorkItems(dir, 'demo').length, 1);
    assertNoFactoryBacklogTaskList(dir);
  } finally {
    cleanup(dir);
  }
});

test('sync-tasks wires factory metadata and sequential dependencies', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    fs.mkdirSync(path.join(dir, 'openspec/changes/demo'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'openspec/changes/demo/tasks.md'), [
      '# Tasks',
      '',
      '- [ ] 1.1 Scaffold app',
      '- [ ] 1.2 Add login form',
      '  factory:',
      '    kind: frontend',
      '    risk: low',
      '    roles: [engineer, test-engineer, reviewer]',
      '    checks: [unit, build, playwright]',
      '    dependencies: ["1.1"]',
      '',
    ].join('\n'));
    assert.equal((await idefactory(dir, ['sync-tasks', 'demo'])).code, 0);
    const second = getWorkItem(dir, 'demo', '1.2');
    assert.equal(second.factory.kind, 'frontend');
    assert.deepEqual(second.dependencies, ['1.1']);
    assert.ok(second.factory.roles.includes('test-engineer'));
    assert.ok(second.factory.checks.includes('playwright'));
  } finally {
    cleanup(dir);
  }
});

test('sync-tasks errors for a missing change and creates nothing', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const result = await idefactory(dir, ['sync-tasks', 'missing-change']);
    assert.notEqual(result.code, 0);
    assert.equal(listWorkItems(dir).length, 0);
  } finally {
    cleanup(dir);
  }
});

test('next prints one engineer packet and HALT blocks next and sync', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    fs.mkdirSync(path.join(dir, 'openspec/changes/demo'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'openspec/changes/demo/tasks.md'), '- [ ] 9.1 Add parser\n');
    assert.equal((await idefactory(dir, ['sync-tasks', 'demo'])).code, 0);
    const packet = await idefactory(dir, ['next', '--change', 'demo']);
    assert.equal(packet.code, 0, packet.err);
    assert.match(packet.out, /Role: engineer/);
    assert.match(packet.out, /\.factory\/agents\/engineer\/charter\.md/);
    assert.doesNotMatch(packet.out, /\.factory\/agents\/lead\/charter\.md/);
    assert.doesNotMatch(packet.out, /\.factory\/agents\/reviewer\/charter\.md/);
    assert.match(packet.out, /failing test/i);
    assert.match(packet.out, /verification/i);
    assert.match(packet.out, /different role/i);
    assert.match(packet.out, /Prefer common scaffolds|create vite/i);
    assert.match(packet.out, /Model profile:/);

    fs.writeFileSync(path.join(dir, 'HALT'), 'stop\n');
    const haltedNext = await idefactory(dir, ['next', '--change', 'demo']);
    assert.notEqual(haltedNext.code, 0);
    assert.doesNotMatch(haltedNext.out, /Work packet/);
    const haltedSync = await idefactory(dir, ['sync-tasks', 'demo']);
    assert.notEqual(haltedSync.code, 0);
  } finally {
    cleanup(dir);
  }
});

test('dependency ordering blocks 1.2 until 1.1 is done', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    fs.mkdirSync(path.join(dir, 'openspec/changes/demo'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'openspec/changes/demo/tasks.md'), [
      '- [ ] 1.1 First',
      '- [ ] 1.2 Second',
    ].join('\n'));
    assert.equal((await idefactory(dir, ['sync-tasks', 'demo'])).code, 0);
    const packet = await idefactory(dir, ['next', '--change', 'demo']);
    assert.match(packet.out, /Work item: demo\/1\.1/);
    assert.doesNotMatch(packet.out, /Work item: demo\/1\.2/);
  } finally {
    cleanup(dir);
  }
});

test('sync stores task class and rejects an unknown taskType before writing', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    writeDemoTasks(dir, [
      '- [ ] 1.1 Update the docs',
      '- [ ] 1.2 Update the readme',
      '  factory:',
      '    taskType: code',
      '',
    ].join('\n'));
    assert.equal((await idefactory(dir, ['sync-tasks', 'demo'])).code, 0);
    assert.equal(getWorkItem(dir, 'demo', '1.1').factory.taskType, 'lightweight');
    assert.equal(getWorkItem(dir, 'demo', '1.2').factory.taskType, 'code');
  } finally {
    cleanup(dir);
  }

  const rejected = tempProject();
  try {
    assert.equal((await idefactory(rejected, ['init'])).code, 0);
    writeDemoTasks(rejected, [
      '- [ ] 1.1 Sketch a parser',
      '  factory:',
      '    taskType: sketch',
      '',
    ].join('\n'));
    const result = await idefactory(rejected, ['sync-tasks', 'demo']);
    assert.notEqual(result.code, 0);
    assert.match(result.err, /taskType/);
    assert.equal(getWorkItem(rejected, 'demo', '1.1'), null);
  } finally {
    cleanup(rejected);
  }
});

test('route defaults to full, a task override wins, and an unknown route writes nothing', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    writeDemoTasks(dir, [
      'factory-route: quick',
      '',
      '- [ ] 1.1 Add a page',
      '- [ ] 1.2 Fix the parser',
      '  factory:',
      '    route: full',
      '',
    ].join('\n'));
    assert.equal((await idefactory(dir, ['sync-tasks', 'demo'])).code, 0);
    assert.equal(getWorkItem(dir, 'demo', '1.1').factory.route, 'quick');
    assert.equal(getWorkItem(dir, 'demo', '1.2').factory.route, 'full');
  } finally {
    cleanup(dir);
  }

  const suggested = tempProject();
  try {
    assert.equal((await idefactory(suggested, ['init'])).code, 0);
    writeDemoTasks(suggested, '- [ ] 1.1 Fix the login bug\n');
    const synced = await idefactory(suggested, ['sync-tasks', 'demo']);
    assert.equal(synced.code, 0, synced.err);
    assert.match(synced.out, /suggested route: quick/);
    assert.equal(getWorkItem(suggested, 'demo', '1.1').factory.route, 'full');
  } finally {
    cleanup(suggested);
  }

  const bad = tempProject();
  try {
    assert.equal((await idefactory(bad, ['init'])).code, 0);
    writeDemoTasks(bad, [
      '- [ ] 1.1 Add a page',
      '  factory:',
      '    route: sketch',
      '',
    ].join('\n'));
    const result = await idefactory(bad, ['sync-tasks', 'demo']);
    assert.notEqual(result.code, 0);
    assert.match(result.err, /route/);
    assert.equal(getWorkItem(bad, 'demo', '1.1'), null);
  } finally {
    cleanup(bad);
  }
});

test('quick auth does not infer security and full auth does', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    writeDemoTasks(dir, [
      '- [ ] 1.1 Fix auth token',
      '  factory:',
      '    route: quick',
      '- [ ] 1.2 Fix auth token',
      '  factory:',
      '    route: full',
      '- [ ] 1.3 Fix auth token',
      '  factory:',
      '    route: quick',
      '    securityProfile: security-sensitive',
      '    checks: [unit, threat-review]',
      '',
    ].join('\n'));
    assert.equal((await idefactory(dir, ['sync-tasks', 'demo'])).code, 0);
    const quick = getWorkItem(dir, 'demo', '1.1');
    const full = getWorkItem(dir, 'demo', '1.2');
    const explicit = getWorkItem(dir, 'demo', '1.3');
    assert.notEqual(quick.factory.securityProfile, 'security-sensitive');
    assert.equal(quick.factory.checks.some((check) => /security|sast|threat|secret|audit/i.test(check)), false);
    assert.deepEqual(quick.factory.roles, ['engineer', 'reviewer', 'scribe']);
    assert.equal(full.factory.securityProfile, 'security-sensitive');
    assert.equal(explicit.factory.securityProfile, 'security-sensitive');
    assert.ok(explicit.factory.checks.includes('threat-review'));
  } finally {
    cleanup(dir);
  }
});

test('implementer packets include prior rejections and reviewer packets omit them', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    writeDemoTasks(dir, [
      '- [ ] 1.1 Add parser',
      '  factory:',
      '    verificationProfile: release',
      '    checks: [unit]',
      '    roles: [engineer, reviewer, scribe]',
      '',
    ].join('\n'));
    assert.equal((await idefactory(dir, ['sync-tasks', 'demo'])).code, 0);
    const item = getWorkItem(dir, 'demo', '1.1');
    const attempts = path.join(dir, '.factory/attempts');
    fs.mkdirSync(attempts, { recursive: true });
    fs.writeFileSync(path.join(attempts, 'attempt-old.json'), JSON.stringify({
      id: 'attempt-old',
      change: 'demo',
      taskId: '1.1',
      state: 'rejected',
      createdAt: '2026-11-01T00:00:00.000Z',
      evidence: { review: { verdict: 'REJECT', notes: 'first rejection' } },
    }));
    fs.writeFileSync(path.join(attempts, 'attempt-new.json'), JSON.stringify({
      id: 'attempt-new',
      change: 'demo',
      taskId: '1.1',
      state: 'rejected',
      createdAt: '2026-11-02T00:00:00.000Z',
      evidence: {
        review: { verdict: 'REJECT', notes: 'second rejection' },
        securityReview: { verdict: 'REJECT', notes: 'security note' },
      },
    }));
    fs.writeFileSync(path.join(attempts, 'attempt-empty.json'), JSON.stringify({
      id: 'attempt-empty',
      change: 'demo',
      taskId: '1.1',
      state: 'rejected',
      createdAt: '2026-11-03T00:00:00.000Z',
      evidence: { review: { verdict: 'REJECT', notes: '' } },
    }));
    const implementer = renderWorkPacket(dir, item, 'engineer');
    assert.match(implementer, /Prior rejections/);
    assert.match(implementer, /attempt-old: first rejection/);
    assert.match(implementer, /attempt-new: second rejection/);
    assert.match(implementer, /attempt-new security review: security note/);
    assert.match(implementer, /attempt-empty: /);
    assert.ok(implementer.indexOf('attempt-old') < implementer.indexOf('attempt-new'));
    assert.ok(implementer.indexOf('attempt-new') < implementer.indexOf('attempt-empty'));
    const reviewer = renderWorkPacket(dir, item, 'reviewer');
    assert.doesNotMatch(reviewer, /Prior rejections/);
    const security = renderWorkPacket(dir, item, 'security-reviewer');
    assert.doesNotMatch(security, /Prior rejections/);
    const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
    const attemptId = JSON.parse(started.out).id;
    const file = path.join(dir, '.factory/attempts', `${attemptId}.json`);
    const attempt = JSON.parse(fs.readFileSync(file, 'utf8'));
    attempt.state = 'accepted';
    attempt.implementerId = 'engineer-1';
    attempt.reviewerId = 'reviewer-1';
    fs.writeFileSync(file, JSON.stringify(attempt, null, 2));
    const done = await idefactory(dir, ['complete', 'demo', '1.1', '--attempt', attemptId]);
    assert.notEqual(done.code, 0);
    assert.match(done.err, /approval|humanGate/i);
    assert.notEqual(getWorkItem(dir, 'demo', '1.1').status, 'done');
  } finally {
    cleanup(dir);
  }
});

test('installed factory skills describe prior rejections and the quick reviewer', () => {
  for (const dir of ['.cursor', '.github', '.agents', '.claude', 'templates']) {
    const build = fs.readFileSync(path.join(repoRoot, dir, 'skills/factory-build/SKILL.md'), 'utf8');
    assert.match(build, /Prior rejections/);
    const runSkill = fs.readFileSync(path.join(repoRoot, dir, 'skills/factory-run/SKILL.md'), 'utf8');
    assert.match(runSkill, /route still requires the reviewer/i);
  }
});
