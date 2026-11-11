import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateCheckRegistry } from '../src/lib/verification-evidence.mjs';
import { cleanup, idefactory, repoRoot, tempProject } from './helpers.mjs';

const ROLES = [
  'lead',
  'architect',
  'engineer',
  'test-engineer',
  'security-reviewer',
  'reviewer',
  'scribe',
];

const SHARED_COMMANDS = ['status', 'plan', 'build', 'run', 'full', 'review', 'setup'];

/** Skill each shared command must direct the IDE to follow (by purpose, not bare name). */
const COMMAND_SKILLS = {
  status: [/factory-coordinator/i],
  plan: [/factory-openspec/i],
  build: [/factory-build/i],
  run: [/factory-run/i],
  full: [/factory-full/i],
  review: [/factory-build/i, /factory-governance/i],
  setup: [/factory-setup/i],
};

function mapUnit(dir) {
  const registryPath = path.join(dir, '.factory/checks.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  registry.checks.unit = {
    argv: ['node', '--test'],
    cwdPolicy: 'project',
    timeoutMs: 120000,
    artifacts: [],
  };
  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

function read(dir, rel) {
  return fs.readFileSync(path.join(dir, rel), 'utf8');
}

function adapterPaths(command) {
  return [
    `.cursor/commands/factory-${command}.md`,
    `.claude/commands/factory-${command}.md`,
    `.github/prompts/factory-${command}.prompt.md`,
  ];
}

test('init writes the seven-role roster, governance baseline, and machine work state', async () => {
  const dir = tempProject();
  try {
    fs.writeFileSync(path.join(dir, 'app.js'), 'keep-app\n');
    const result = await idefactory(dir, ['init']);
    assert.equal(result.code, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), 'keep-app\n');
    const team = read(dir, '.factory/team.md');
    for (const role of ['Lead', 'Architect', 'Engineer', 'Test Engineer', 'Security Reviewer', 'Reviewer', 'Scribe']) {
      assert.match(team, new RegExp(role));
    }
    assert.match(team, /does not implement product code/);
    for (const role of ROLES) {
      assert.equal(fs.existsSync(path.join(dir, `.factory/agents/${role}/charter.md`)), true, role);
      assert.equal(fs.existsSync(path.join(dir, `.factory/agents/${role}/history.md`)), true, role);
    }
    assert.equal(fs.existsSync(path.join(dir, '.factory/decisions.md')), true);
    assert.equal(fs.existsSync(path.join(dir, '.factory/governance.md')), true);
    assert.equal(fs.existsSync(path.join(dir, '.factory/profiles.json')), true);
    assert.equal(fs.existsSync(path.join(dir, '.factory/work/index.json')), true);
    assert.equal(fs.existsSync(path.join(dir, '.factory/attempts')), true);
    const governance = read(dir, '.factory/governance.md');
    assert.match(governance, /approve/i);
    assert.match(governance, /verif/i);
    assert.match(governance, /append-only|memor/i);
    assert.match(governance, /HALT/);
    assert.match(governance, /review/i);
    assert.match(governance, /\.factory\/work|queue/i);
    assert.equal(fs.existsSync(path.join(dir, 'GOLDEN_RULES.md')), false);
    const config = JSON.parse(read(dir, '.factory/config.json'));
    assert.equal(config.runtime, 'ide');
    assert.equal(config.ideation, false);
  } finally {
    cleanup(dir);
  }
});

test('init writes a schema-valid check registry with no unit command', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const registryPath = path.join(dir, '.factory/checks.json');
    assert.equal(fs.existsSync(registryPath), true, '.factory/checks.json must exist after init');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    assert.equal(registry.schemaVersion, 1);
    assert.deepEqual(registry.checks, {});
    const accepted = validateCheckRegistry(registry, { projectRoot: dir });
    assert.equal(accepted.schemaVersion, 1);
    assert.deepEqual(accepted.checks, {});
  } finally {
    cleanup(dir);
  }
});

test('init writes positive run-budget defaults in config', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const run = JSON.parse(read(dir, '.factory/config.json')).run;
    assert.ok(Number.isInteger(run.defaultMaxAgentSteps) && run.defaultMaxAgentSteps > 0);
    assert.ok(Number.isInteger(run.defaultMaxTasks) && run.defaultMaxTasks > 0);
    assert.ok(Number.isInteger(run.defaultMaxWallClockMs) && run.defaultMaxWallClockMs > 0);
    assert.ok(Number.isInteger(run.defaultMaxFailures) && run.defaultMaxFailures > 0);
  } finally {
    cleanup(dir);
  }
});

test('re-init leaves an existing config byte-for-byte unchanged', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const configPath = path.join(dir, '.factory/config.json');
    const custom = `${read(dir, '.factory/config.json').trimEnd()}\nCONFIG-SENTINEL\n`;
    fs.writeFileSync(configPath, custom);
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    assert.equal(fs.readFileSync(configPath, 'utf8'), custom);
  } finally {
    cleanup(dir);
  }
});

test('re-init leaves an existing check registry byte-for-byte unchanged', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const registryPath = path.join(dir, '.factory/checks.json');
    const custom = `${JSON.stringify({
      schemaVersion: 1,
      checks: {
        unit: {
          argv: ['npm', 'test'],
          cwdPolicy: 'project',
          timeoutMs: 12_345,
          artifacts: [],
        },
      },
    }, null, 2)}\nCUSTOM-REGISTRY-SENTINEL\n`;
    fs.writeFileSync(registryPath, custom);
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    assert.equal(fs.readFileSync(registryPath, 'utf8'), custom);
  } finally {
    cleanup(dir);
  }
});

test('init writes release and security-sensitive humanGate true', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const profiles = JSON.parse(read(dir, '.factory/profiles.json'));
    assert.equal(profiles.release.humanGate, true);
    assert.equal(profiles['security-sensitive'].humanGate, true);
  } finally {
    cleanup(dir);
  }
});

test('re-init leaves an existing profiles.json byte-for-byte unchanged', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const profilesPath = path.join(dir, '.factory/profiles.json');
    const custom = `${JSON.stringify({
      docs: { checks: ['docs'], humanGate: false },
      'security-sensitive': {
        checks: ['unit', 'threat-review'],
        humanGate: false,
      },
      release: { checks: ['unit'], humanGate: true },
    }, null, 2)}\nPROFILES-SENTINEL\n`;
    fs.writeFileSync(profilesPath, custom);
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    assert.equal(fs.readFileSync(profilesPath, 'utf8'), custom);
  } finally {
    cleanup(dir);
  }
});

test('re-init preserves decisions, history, squad, and AGENTS.md', async () => {
  const dir = tempProject();
  try {
    fs.mkdirSync(path.join(dir, '.squad'));
    fs.writeFileSync(path.join(dir, '.squad/team.md'), 'SQUAD-BYTES\n');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'Project alpha stays\n');
    fs.writeFileSync(path.join(dir, 'GOLDEN_RULES.md'), 'HUMAN-OWNED-RULES\n');
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    fs.appendFileSync(path.join(dir, '.factory/decisions.md'), '\nACCEPTED-SENTINEL\n');
    fs.appendFileSync(path.join(dir, '.factory/agents/engineer/history.md'), '\nSESSION-NOTE\n');
    fs.mkdirSync(path.join(dir, '.cursor/skills/openspec-propose'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.cursor/skills/openspec-propose/SKILL.md'), 'KEEP-OPENSPEC\n');
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    assert.match(read(dir, '.factory/decisions.md'), /ACCEPTED-SENTINEL/);
    assert.match(read(dir, '.factory/agents/engineer/history.md'), /SESSION-NOTE/);
    assert.equal(fs.readFileSync(path.join(dir, '.squad/team.md'), 'utf8'), 'SQUAD-BYTES\n');
    const agents = read(dir, 'AGENTS.md');
    assert.match(agents, /Project alpha stays/);
    assert.equal(agents.split('<!-- idefactory:start -->').length - 1, 1);
    assert.equal(fs.readFileSync(path.join(dir, 'GOLDEN_RULES.md'), 'utf8'), 'HUMAN-OWNED-RULES\n');
    assert.equal(fs.readFileSync(path.join(dir, '.cursor/skills/openspec-propose/SKILL.md'), 'utf8'), 'KEEP-OPENSPEC\n');
  } finally {
    cleanup(dir);
  }
});

test('installs the full shared adapter command set for Cursor, Copilot, and Claude', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    for (const command of SHARED_COMMANDS) {
      for (const rel of adapterPaths(command)) {
        assert.equal(fs.existsSync(path.join(dir, rel)), true, rel);
        const body = read(dir, rel);
        for (const skill of COMMAND_SKILLS[command]) {
          assert.match(
            body,
            skill,
            `${rel} must direct the IDE to the corresponding factory skill (${skill})`,
          );
        }
      }
    }
    assert.match(read(dir, '.cursor/skills/factory-full/SKILL.md'), /openspec-explore/);
    assert.match(read(dir, '.cursor/skills/factory-full/SKILL.md'), /factory-run/);
    assert.match(read(dir, '.cursor/rules/factory.mdc'), /Unrelated requests are left alone/);
    const build = read(dir, '.cursor/skills/factory-build/SKILL.md');
    assert.match(build, /failing test/i);
    assert.match(build, /verification/i);
    assert.match(build, /different role/i);
    assert.match(build, /idefactory complete/);
  } finally {
    cleanup(dir);
  }
});

test('init writes Cline rule, skills, and workflows under .cline only', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const clineRule = read(dir, '.cline/rules/factory.md');
    assert.match(clineRule, /Unrelated requests are left alone/);
    assert.doesNotMatch(clineRule, /^---/m);
    assert.match(clineRule, /<!-- idefactory:owned -->/);

    const clineSkills = [
      'factory-coordinator',
      'factory-openspec',
      'factory-build',
      'factory-run',
      'factory-full',
      'factory-governance',
      'factory-tdd',
      'factory-verify',
      'factory-debug',
      'factory-setup',
    ];
    for (const name of clineSkills) {
      const rel = `.cline/skills/${name}/SKILL.md`;
      assert.equal(fs.existsSync(path.join(dir, rel)), true, rel);
    }

    for (const command of SHARED_COMMANDS) {
      const rel = `.cline/workflows/factory-${command}.md`;
      assert.equal(fs.existsSync(path.join(dir, rel)), true, rel);
      const body = read(dir, rel);
      for (const skill of COMMAND_SKILLS[command]) {
        assert.match(
          body,
          skill,
          `${rel} must direct Cline to the same factory skill as the Cursor command (${skill})`,
        );
      }
      assert.doesNotMatch(body, /^description:/m);
      assert.doesNotMatch(body, /^agent:\s*factory/m);
      assert.match(body, /<!-- idefactory:owned -->/);
    }

    assert.equal(fs.existsSync(path.join(dir, '.cline/work')), false);
    assert.equal(fs.existsSync(path.join(dir, '.clinerules')), false);
  } finally {
    cleanup(dir);
  }
});

test('installed factory skills state the IDE session model and do not launch a model', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const launchPattern = /idefactory\b[\s\S]{0,80}\b(launch|start)\b[\s\S]{0,40}\bmodel\b|\bcursor-agent\b/i;
    for (const root of ['.cursor/skills', '.claude/skills', '.github/skills', '.cline/skills']) {
      const skillRoot = path.join(dir, root);
      for (const name of fs.readdirSync(skillRoot).sort()) {
        const rel = path.join(root, name, 'SKILL.md');
        const body = read(dir, rel);
        assert.match(
          body,
          /IDE session model does the work/i,
          `${rel} must state that the IDE session model does the work`,
        );
        assert.doesNotMatch(body, launchPattern, `${rel} must not direct the CLI to launch a model`);
      }
    }
    for (const command of SHARED_COMMANDS) {
      for (const rel of [
        ...adapterPaths(command),
        `.cline/workflows/factory-${command}.md`,
      ]) {
        assert.doesNotMatch(
          read(dir, rel),
          launchPattern,
          `${rel} must not direct the CLI to launch a model`,
        );
      }
    }
  } finally {
    cleanup(dir);
  }
});

test('upgrade refreshes an owned skill and keeps a custom decision', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    fs.appendFileSync(path.join(dir, '.factory/decisions.md'), '\nCUSTOM-DECISION-KEEP\n');
    fs.writeFileSync(
      path.join(dir, '.cursor/skills/factory-coordinator/SKILL.md'),
      '---\nname: factory-coordinator\n---\nOLD-SKILL-BODY\n<!-- idefactory:owned -->\n',
    );
    assert.equal((await idefactory(dir, ['upgrade'])).code, 0);
    assert.match(read(dir, '.factory/decisions.md'), /CUSTOM-DECISION-KEEP/);
    const skill = read(dir, '.cursor/skills/factory-coordinator/SKILL.md');
    assert.doesNotMatch(skill, /OLD-SKILL-BODY/);
    assert.match(skill, /You route work/);
  } finally {
    cleanup(dir);
  }
});

test('init and upgrade preserve unrelated Cline files and refresh owned Cline skills', async () => {
  const dir = tempProject();
  try {
    const appBytes = 'keep-app-cline\n';
    const teamStyleBytes = '# Team style\nTEAM-STYLE-BYTES\n';
    const otherClineBytes = 'OTHER-CLINE-KEEP\n';
    fs.writeFileSync(path.join(dir, 'app.js'), appBytes);
    fs.mkdirSync(path.join(dir, '.cline/rules'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.cline/rules/team-style.md'), teamStyleBytes);
    fs.mkdirSync(path.join(dir, '.cline/notes'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.cline/notes/keep.md'), otherClineBytes);

    assert.equal((await idefactory(dir, ['init'])).code, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), appBytes);
    assert.equal(fs.readFileSync(path.join(dir, '.cline/rules/team-style.md'), 'utf8'), teamStyleBytes);
    assert.equal(fs.readFileSync(path.join(dir, '.cline/notes/keep.md'), 'utf8'), otherClineBytes);

    fs.appendFileSync(path.join(dir, '.factory/decisions.md'), '\nCUSTOM-DECISION-KEEP\n');
    fs.writeFileSync(
      path.join(dir, '.cline/skills/factory-coordinator/SKILL.md'),
      '---\nname: factory-coordinator\n---\nOLD-CLINE-SKILL-BODY\n<!-- idefactory:owned -->\n',
    );

    assert.equal((await idefactory(dir, ['upgrade'])).code, 0);
    assert.match(read(dir, '.factory/decisions.md'), /CUSTOM-DECISION-KEEP/);
    const clineSkill = read(dir, '.cline/skills/factory-coordinator/SKILL.md');
    assert.doesNotMatch(clineSkill, /OLD-CLINE-SKILL-BODY/);
    assert.match(clineSkill, /You route work/);
    assert.equal(fs.readFileSync(path.join(dir, '.cline/rules/team-style.md'), 'utf8'), teamStyleBytes);
    assert.equal(fs.readFileSync(path.join(dir, '.cline/notes/keep.md'), 'utf8'), otherClineBytes);
    assert.equal(fs.existsSync(path.join(dir, 'app.js')), true);
    assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), appBytes);
  } finally {
    cleanup(dir);
  }
});

test('AGENTS.md factory section names the Cline factory rule', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const agents = read(dir, 'AGENTS.md');
    const start = agents.indexOf('<!-- idefactory:start -->');
    const end = agents.indexOf('<!-- idefactory:end -->');
    assert.notEqual(start, -1, 'AGENTS.md must contain the marked factory section start');
    assert.notEqual(end, -1, 'AGENTS.md must contain the marked factory section end');
    assert.ok(end > start, 'factory section end must follow start');
    const section = agents.slice(start, end + '<!-- idefactory:end -->'.length);
    assert.match(section, /\.cline\/rules\/factory\.md/);
  } finally {
    cleanup(dir);
  }
});

test('doctor fails in an empty directory and after init until a test decision is recorded', async () => {
  const dir = tempProject();
  try {
    assert.notEqual((await idefactory(dir, ['doctor'])).code, 0);
    const created = await idefactory(dir, ['init']);
    assert.equal(created.code, 0);
    assert.match(created.out, /missing test decision/);
    assert.equal(fs.existsSync(path.join(dir, 'backlog')), false);
    const beforeSetup = await idefactory(dir, ['doctor']);
    assert.notEqual(beforeSetup.code, 0);
    assert.match(beforeSetup.out, /missing test decision/);
    mapUnit(dir);
    assert.equal((await idefactory(dir, ['doctor'])).code, 0);
  } finally {
    cleanup(dir);
  }
});

test('doctor requires Cline factory rule and coordinator skill', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    mapUnit(dir);
    assert.equal((await idefactory(dir, ['doctor'])).code, 0);

    const rulePath = path.join(dir, '.cline/rules/factory.md');
    const skillPath = path.join(dir, '.cline/skills/factory-coordinator/SKILL.md');
    const ruleBody = fs.readFileSync(rulePath);
    const skillBody = fs.readFileSync(skillPath);

    fs.unlinkSync(rulePath);
    const missingRule = await idefactory(dir, ['doctor']);
    assert.notEqual(missingRule.code, 0);
    assert.match(missingRule.out, /missing \.cline\/rules\/factory\.md/);

    fs.writeFileSync(rulePath, ruleBody);
    fs.unlinkSync(skillPath);
    const missingSkill = await idefactory(dir, ['doctor']);
    assert.notEqual(missingSkill.code, 0);
    assert.match(missingSkill.out, /missing \.cline\/skills\/factory-coordinator\/SKILL\.md/);
  } finally {
    cleanup(dir);
  }
});

test('README tells a project how to install and who does the work', () => {
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  assert.match(readme, /idefactory init/);
  assert.match(readme, /The IDE's own model does the work/);
  assert.match(readme, /\.factory\/work/);
  assert.match(readme, /\.cline\/rules\/factory\.md/);
  assert.match(readme, /\.cline\/skills\/<name>\//);
  assert.match(readme, /\.cline\/workflows\/factory-\*\.md/);
  assert.match(readme, /Node 24/);
  assert.match(readme, /Python 3\.14/);
  assert.doesNotMatch(readme, /--skip-semgrep/);
});

test('the CLI process does not execute a model binary on next', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    for (const name of ['cursor-agent']) {
      const file = path.join(bin, name);
      fs.writeFileSync(file, '#!/bin/sh\ntouch "$IDEFACTORY_MODEL_RAN"\n');
      fs.chmodSync(file, 0o755);
    }
    const marker = path.join(dir, 'model-ran');
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'src/cli.mjs'), 'next', '--path', dir], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        IDEFACTORY_MODEL_RAN: marker,
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(marker), false);
    assert.doesNotMatch(result.stdout, /Work packet/);
  } finally {
    cleanup(dir);
  }
});

test('implementation notes record add-cline-ide-adapter verification commands', () => {
  const notesPath = path.join(
    repoRoot,
    'openspec/changes/archive/2026-10-22-add-cline-ide-adapter/implementation-notes.md',
  );
  assert.ok(fs.existsSync(notesPath), `missing implementation notes: ${notesPath}`);
  const notes = fs.readFileSync(notesPath, 'utf8');
  const commands = [
    'npx openspec validate add-cline-ide-adapter --strict',
    'npx openspec validate --all',
    'node --test test/install.test.mjs',
  ];
  let cursor = 0;
  for (const command of commands) {
    const idx = notes.indexOf(command, cursor);
    assert.ok(idx !== -1, `notes must contain \`${command}\` in order`);
    const after = notes.slice(idx + command.length);
    assert.match(
      after,
      /Exit code:\s*`?\d+`?/,
      `notes must record an exit code for \`${command}\``,
    );
    cursor = idx + command.length;
  }
});

test('new init sets policy version 1 without a verifier and reinstall preserves policy and checks.json', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const configPath = path.join(dir, '.factory/config.json');
    const created = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(created.governance.policyVersion, 1);
    assert.equal(created.governance.principalVerifier, undefined);
    created.governance.policyVersion = 2;
    fs.writeFileSync(configPath, JSON.stringify(created, null, 2));
    const registryPath = path.join(dir, '.factory/checks.json');
    const custom = '{"schemaVersion":1,"checks":{"unit":{"argv":["npm","test"],"cwdPolicy":"project","timeoutMs":120000,"artifacts":[]},"project":{"argv":["node","-e","process.exit(0)"],"cwdPolicy":"project","timeoutMs":1000,"artifacts":[]}}}\n';
    fs.writeFileSync(registryPath, custom);
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const again = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(again.governance.policyVersion, 2);
    assert.equal(fs.readFileSync(registryPath, 'utf8'), custom);
  } finally {
    cleanup(dir);
  }
});

test('factory-setup waits for confirmation and the README documents setup', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const skill = read(dir, '.cline/skills/factory-setup/SKILL.md');
    assert.match(skill, /do not run `idefactory setup` before the human confirms/i);
    assert.match(skill, /setup --detect/);
    assert.match(read(dir, '.cline/workflows/factory-setup.md'), /factory-setup/);
    assert.match(read(dir, '.cursor/skills/factory-coordinator/SKILL.md'), /factory-setup/);
    const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
    const section = readme.slice(
      readme.indexOf('## Add it to a project'),
      readme.indexOf('## How a change gets built'),
    );
    assert.match(section, /idefactory setup/);
    assert.match(section, /--governance/);
    assert.match(section, /lightweight/);
    assert.match(section, /--verifier-argv/);
    assert.match(section, /--no-test/);
  } finally {
    cleanup(dir);
  }
});
