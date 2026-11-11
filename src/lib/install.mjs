import fs from 'node:fs';
import path from 'node:path';
import {
  MARKER,
  ROLES,
  ledger,
  mergeMarked,
  readText,
  templatesRoot,
  writeIfMissing,
  writeText,
} from './layout.mjs';
import {
  CONSUMER_WORKFLOW_RELATIVE,
  writeConsumerWorkflowIfAbsent,
} from './ci-scaffold.mjs';
import { runOpenspec } from './openspec-cli.mjs';

const STATE_FILES = [
  'team.md',
  'routing.md',
  'decisions.md',
  'config.json',
  'governance.md',
  'ceremonies.md',
  'profiles.json',
  'checks.json',
  'README.md',
  'identity/now.md',
  'identity/wisdom.md',
];

const COMMANDS = [
  {
    name: 'factory-status',
    description: 'Show factory team, OpenSpec, and work queue status',
  },
  {
    name: 'factory-plan',
    description: 'Staff a human-authored OpenSpec change into .factory/work',
  },
  {
    name: 'factory-build',
    description: 'Implement the next factory work item with the factory-build skill',
  },
  {
    name: 'factory-run',
    description: 'Bounded multi-task factory orchestration until a stop condition',
  },
  {
    name: 'factory-full',
    description: 'One-stop factory: explore, propose if needed, plan, and run',
  },
  {
    name: 'factory-review',
    description: 'Review the current factory task as a different role',
  },
  {
    name: 'factory-setup',
    description: 'Confirm the test command and governance mode, then record them',
  },
];

export function initProject(project, options = {}) {
  fs.mkdirSync(project, { recursive: true });
  const created = writeState(project, options);
  writeAdapters(project);
  mergeInstructions(project);
  ensureWorkScaffold(project);
  if (options.withOpenspec) ensureOpenspec(project, options.env || process.env);
  if (options.withBacklog) {
    // Deprecated: Backlog.md is no longer required. Kept for one release as a no-op hint.
    created.push('(deprecated --with-backlog ignored; use .factory/work)');
  }
  if (writeConsumerWorkflowIfAbsent(project).created) {
    created.push(CONSUMER_WORKFLOW_RELATIVE);
  }
  ledger(project, 'init', { created });
  return created;
}

export function upgradeProject(project) {
  if (!fs.existsSync(path.join(project, '.factory', 'team.md'))) {
    throw new Error('No .factory/ team state. Run idefactory init first.');
  }
  writeAdapters(project);
  mergeInstructions(project);
  ledger(project, 'upgrade', {});
}

function writeState(project, options) {
  const created = [];
  const factory = path.join(project, '.factory');
  const force = Boolean(options.forceRoster);
  for (const rel of STATE_FILES) {
    const from = path.join(templatesRoot, 'factory', rel);
    const to = path.join(factory, rel);
    if (force && (rel === 'team.md' || rel === 'routing.md')) {
      writeText(to, readText(from));
      created.push(rel);
      continue;
    }
    if (writeIfMissing(to, readText(from))) created.push(rel);
  }
  for (const role of ROLES) {
    for (const leaf of ['charter.md', 'history.md']) {
      const rel = path.join('agents', role, leaf);
      const from = path.join(templatesRoot, 'factory', rel);
      const to = path.join(factory, rel);
      if (force && leaf === 'charter.md') {
        writeText(to, readText(from));
        created.push(rel);
        continue;
      }
      if (writeIfMissing(to, readText(from))) created.push(rel);
    }
  }
  writeIfMissing(path.join(factory, 'approvals', '.gitkeep'), '');
  writeIfMissing(path.join(factory, 'orchestration', '.gitkeep'), '');
  ensureWorkScaffold(project);
  return created;
}

function ensureWorkScaffold(project) {
  const work = path.join(project, '.factory', 'work');
  writeIfMissing(path.join(work, 'index.json'), JSON.stringify({ version: 1, items: [] }, null, 2));
  writeIfMissing(path.join(work, 'items', '.gitkeep'), '');
  writeIfMissing(path.join(project, '.factory', 'attempts', '.gitkeep'), '');
}

function writeAdapters(project) {
  const skills = path.join(templatesRoot, 'skills');
  const destinations = [
    '.cursor/skills',
    '.claude/skills',
    '.github/skills',
    '.agents/skills',
    '.cline/skills',
  ];
  for (const name of fs.readdirSync(skills)) {
    const from = path.join(skills, name);
    if (!fs.statSync(from).isDirectory()) continue;
    for (const dest of destinations) {
      fs.cpSync(from, path.join(project, dest, name), { recursive: true });
    }
  }
  for (const command of COMMANDS) {
    const body = readText(path.join(templatesRoot, 'commands', `${command.name}.md`)).trim();
    const owned = `${body}\n\n${MARKER}\n`;
    writeText(
      path.join(project, '.cursor/commands', `${command.name}.md`),
      `---\ndescription: ${command.description}\n---\n\n${owned}`,
    );
    writeText(
      path.join(project, '.claude/commands', `${command.name}.md`),
      `---\ndescription: ${command.description}\n---\n\n${owned}`,
    );
    writeText(
      path.join(project, '.github/prompts', `${command.name}.prompt.md`),
      `---\ndescription: ${command.description}\nagent: factory\n---\n\n${owned}`,
    );
    writeText(
      path.join(project, '.cline/workflows', `${command.name}.md`),
      owned,
    );
  }
  writeText(
    path.join(project, '.cursor/rules/factory.mdc'),
    readText(path.join(templatesRoot, 'cursor/rules/factory.mdc')),
  );
  writeText(
    path.join(project, '.github/agents/factory.agent.md'),
    readText(path.join(templatesRoot, 'copilot/factory.agent.md')),
  );
  writeText(
    path.join(project, '.cline/rules/factory.md'),
    readText(path.join(templatesRoot, 'cline/rules/factory.md')),
  );
}

function mergeInstructions(project) {
  const section = readText(path.join(templatesRoot, 'fragments/instructions.md'));
  const targets = [
    'AGENTS.md',
    'CLAUDE.md',
    path.join('.github', 'copilot-instructions.md'),
  ];
  for (const rel of targets) {
    const file = path.join(project, rel);
    const existing = fs.existsSync(file) ? readText(file) : '';
    writeText(file, mergeMarked(existing, section));
  }
}

function ensureOpenspec(project, env) {
  if (fs.existsSync(path.join(project, 'openspec', 'config.yaml'))) return;
  try {
    runOpenspec(project, [
      'init',
      '--tools', 'cursor,github-copilot,claude',
      '--no-copilot-cloud',
      '--no-animation',
    ], env);
  } catch (error) {
    if (error.code === 'NO_OPENSPEC') throw error;
    throw new Error(error.message || 'openspec init failed');
  }
}
