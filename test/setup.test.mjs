import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { setupProject } from '../src/lib/setup.mjs';
import { acquireWriterLease, readWriterLease, releaseWriterLease } from '../src/lib/writer-lease.mjs';
import { cleanup, idefactory, tempProject } from './helpers.mjs';

function readJson(dir, rel) {
  return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
}

function snapshot(dir) {
  return {
    config: fs.readFileSync(path.join(dir, '.factory/config.json'), 'utf8'),
    checks: fs.readFileSync(path.join(dir, '.factory/checks.json'), 'utf8'),
    decisions: fs.readFileSync(path.join(dir, '.factory/decisions.md'), 'utf8'),
  };
}

test('setup --detect proposes stacks in order and does not write or take the lease', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    fs.writeFileSync(path.join(dir, 'App.csproj'), '<Project />\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    const before = snapshot(dir);
    const lease = acquireWriterLease(dir, 'complete', { leaseId: 'detect-holder' });
    const detected = await idefactory(dir, ['setup', '--detect']);
    assert.equal(detected.code, 0, detected.err);
    const body = JSON.parse(detected.out);
    assert.deepEqual(body.proposals.map((item) => ({
      id: item.id,
      kind: item.kind,
      argv: item.argv,
    })), [
      { id: 'dotnet', kind: 'unit', argv: ['dotnet', 'test'] },
      { id: 'node', kind: 'unit-node', argv: ['npm', 'test'] },
    ]);
    assert.equal(body.proposals[0].defaultUnit, true);
    assert.deepEqual(snapshot(dir), before);
    assert.equal(readWriterLease(dir).leaseId, lease.leaseId);
    releaseWriterLease(dir, lease.leaseId);

    const empty = tempProject();
    try {
      const none = await idefactory(empty, ['setup', '--detect']);
      assert.equal(none.code, 0, none.err);
      assert.deepEqual(JSON.parse(none.out).proposals, []);
      assert.equal(fs.existsSync(path.join(empty, '.factory')), false);
    } finally {
      cleanup(empty);
    }
  } finally {
    cleanup(dir);
  }
});

test('setup --detect proposes one argv for each recognized stack', async () => {
  const cases = [
    { file: 'App.sln', body: '', argv: ['dotnet', 'test'] },
    { file: 'package.json', body: JSON.stringify({ scripts: { test: 'vitest' } }), argv: ['npm', 'test'] },
    { file: 'pyproject.toml', body: '', argv: ['pytest'] },
    { file: 'go.mod', body: 'module example.com/demo\n', argv: ['go', 'test', './...'] },
    { file: 'Cargo.toml', body: '', argv: ['cargo', 'test'] },
    { file: 'pom.xml', body: '<project/>\n', argv: ['mvn', 'test'] },
    { file: 'build.gradle.kts', body: '', argv: ['gradle', 'test'] },
    { file: 'Gemfile', body: "gem 'rspec'\n", argv: ['bundle', 'exec', 'rspec'] },
    { file: 'composer.json', body: JSON.stringify({ 'require-dev': { 'phpunit/phpunit': '^11' } }), argv: ['vendor/bin/phpunit'] },
  ];
  for (const item of cases) {
    const dir = tempProject();
    try {
      fs.writeFileSync(path.join(dir, item.file), item.body);
      const detected = await idefactory(dir, ['setup', '--detect']);
      assert.equal(detected.code, 0, `${item.file}: ${detected.err}`);
      const proposals = JSON.parse(detected.out).proposals;
      assert.equal(proposals.length, 1, item.file);
      assert.deepEqual(proposals[0].argv, item.argv, item.file);
      assert.equal(proposals[0].kind, 'unit', item.file);
    } finally {
      cleanup(dir);
    }
  }
});

test('setup writes confirmed argv and leaves an unmentioned kind in place', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const registry = readJson(dir, '.factory/checks.json');
    registry.checks.unit = {
      argv: ['npm', 'test'],
      cwdPolicy: 'project',
      timeoutMs: 120000,
      artifacts: [],
    };
    registry.checks.lint = {
      argv: ['npm', 'run', 'lint'],
      cwdPolicy: 'project',
      timeoutMs: 120000,
      artifacts: [],
    };
    fs.writeFileSync(path.join(dir, '.factory/checks.json'), `${JSON.stringify(registry, null, 2)}\n`);
    const config = readJson(dir, '.factory/config.json');
    config.governance.note = 'keep-me';
    fs.writeFileSync(path.join(dir, '.factory/config.json'), `${JSON.stringify(config, null, 2)}\n`);

    const written = await idefactory(dir, [
      'setup', '--governance', 'lightweight',
      '--map', 'unit', '--argv', 'dotnet', '--argv', 'test',
    ]);
    assert.equal(written.code, 0, written.err);
    const checks = readJson(dir, '.factory/checks.json');
    assert.deepEqual(checks.checks.unit.argv, ['dotnet', 'test']);
    assert.deepEqual(checks.checks.lint.argv, ['npm', 'run', 'lint']);
    const again = readJson(dir, '.factory/config.json');
    assert.equal(again.governance.policyVersion, 1);
    assert.equal(again.governance.principalVerifier, undefined);
    assert.equal(again.governance.note, 'keep-me');
  } finally {
    cleanup(dir);
  }
});

test('setup rejects a shell string, a strict setup without a verifier, and a missing answer', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const before = snapshot(dir);

    const shell = await idefactory(dir, [
      'setup', '--governance', 'lightweight', '--map', 'unit', '--argv', 'dotnet test',
    ]);
    assert.notEqual(shell.code, 0);
    assert.match(shell.err, /shell|argv/i);
    assert.deepEqual(snapshot(dir), before);

    const strict = await idefactory(dir, [
      'setup', '--governance', 'strict', '--map', 'unit', '--argv', 'dotnet', '--argv', 'test',
    ]);
    assert.notEqual(strict.code, 0);
    assert.match(`${strict.err}${strict.out}`, /verifier/i);
    assert.deepEqual(snapshot(dir), before);

    const missing = await idefactory(dir, ['setup']);
    assert.notEqual(missing.code, 0);
    assert.match(`${missing.err}${missing.out}`, /governance/);
    assert.match(`${missing.err}${missing.out}`, /idefactory setup/);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    cleanup(dir);
  }
});

test('setup records strict verifier argv and an explicit no-test decision', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const strict = await idefactory(dir, [
      'setup', '--governance', 'strict',
      '--map', 'unit', '--argv', 'node', '--argv', 'scripts/verify-principal.mjs',
      '--verifier-argv', 'node', '--verifier-argv', 'scripts/verify-principal.mjs',
    ]);
    assert.equal(strict.code, 0, strict.err);
    const config = readJson(dir, '.factory/config.json');
    assert.equal(config.governance.policyVersion, 2);
    assert.deepEqual(config.governance.principalVerifier.argv, ['node', 'scripts/verify-principal.mjs']);

    const none = await idefactory(dir, ['setup', '--governance', 'lightweight', '--no-test']);
    assert.equal(none.code, 0, none.err);
    const after = readJson(dir, '.factory/checks.json');
    assert.equal(after.checks.unit, undefined);
    const light = readJson(dir, '.factory/config.json');
    assert.equal(light.governance.policyVersion, 1);
    assert.equal(light.governance.principalVerifier, undefined);
    assert.equal(light.governance.testDecision, 'none');
    assert.equal((await idefactory(dir, ['doctor'])).code, 0);
  } finally {
    cleanup(dir);
  }
});

test('a terminal prompt writes only after both answers exist', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    fs.writeFileSync(path.join(dir, 'App.csproj'), '<Project />\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    const questions = [];
    const answers = ['', 'node', 'lightweight'];
    const result = await setupProject(dir, {
      isTTY: true,
      ask: async (question) => {
        questions.push(question);
        assert.deepEqual(readJson(dir, '.factory/checks.json').checks, {});
        assert.equal(readJson(dir, '.factory/config.json').governance.policyVersion, 1);
        return answers.shift();
      },
    });
    assert.equal(result.wrote, true);
    assert.match(questions.join('\n'), /Keep stacks/);
    assert.match(questions.join('\n'), /unit/i);
    assert.match(questions.join('\n'), /Governance/);
    const checks = readJson(dir, '.factory/checks.json');
    assert.deepEqual(checks.checks.unit.argv, ['npm', 'test']);
    assert.deepEqual(checks.checks['unit-dotnet'].argv, ['dotnet', 'test']);
    assert.equal(checks.checks['unit-node'], undefined);
  } finally {
    cleanup(dir);
  }
});

test('a terminal prompt can drop a stack and can accept a typed command', async () => {
  const kept = tempProject();
  try {
    assert.equal((await idefactory(kept, ['init'])).code, 0);
    fs.writeFileSync(path.join(kept, 'App.csproj'), '<Project />\n');
    fs.writeFileSync(path.join(kept, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    const keptAnswers = ['node', 'lightweight'];
    await setupProject(kept, {
      isTTY: true,
      ask: async () => keptAnswers.shift(),
    });
    const checks = readJson(kept, '.factory/checks.json');
    assert.deepEqual(checks.checks.unit.argv, ['npm', 'test']);
    assert.equal(checks.checks['unit-dotnet'], undefined);
    assert.equal(checks.checks['unit-node'], undefined);
  } finally {
    cleanup(kept);
  }

  const defaults = tempProject();
  try {
    assert.equal((await idefactory(defaults, ['init'])).code, 0);
    fs.writeFileSync(path.join(defaults, 'App.csproj'), '<Project />\n');
    fs.writeFileSync(path.join(defaults, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    const defaultAnswers = ['', '', 'lightweight'];
    await setupProject(defaults, {
      isTTY: true,
      ask: async () => defaultAnswers.shift(),
    });
    const checks = readJson(defaults, '.factory/checks.json');
    assert.deepEqual(checks.checks.unit.argv, ['dotnet', 'test']);
    assert.deepEqual(checks.checks['unit-node'].argv, ['npm', 'test']);
  } finally {
    cleanup(defaults);
  }

  const typed = tempProject();
  try {
    assert.equal((await idefactory(typed, ['init'])).code, 0);
    const typedAnswers = ['pytest -q', 'strict', 'node scripts/verify-principal.mjs'];
    await setupProject(typed, {
      isTTY: true,
      ask: async () => typedAnswers.shift(),
    });
    assert.deepEqual(readJson(typed, '.factory/checks.json').checks.unit.argv, ['pytest', '-q']);
    const config = readJson(typed, '.factory/config.json');
    assert.equal(config.governance.policyVersion, 2);
    assert.deepEqual(config.governance.principalVerifier.argv, ['node', 'scripts/verify-principal.mjs']);
  } finally {
    cleanup(typed);
  }
});

test('init and upgrade print the setup gap without rewriting the registry or decisions', async () => {
  const dir = tempProject();
  try {
    const created = await idefactory(dir, ['init']);
    assert.equal(created.code, 0, created.err);
    assert.match(created.out, /missing test decision/);
    assert.doesNotMatch(created.out, /\?/);
    fs.appendFileSync(path.join(dir, '.factory/decisions.md'), '\nCUSTOM-DECISION-KEEP\n');
    const before = snapshot(dir);
    const upgraded = await idefactory(dir, ['upgrade']);
    assert.equal(upgraded.code, 0, upgraded.err);
    assert.match(upgraded.out, /missing test decision/);
    assert.equal(snapshot(dir).checks, before.checks);
    assert.match(snapshot(dir).decisions, /CUSTOM-DECISION-KEEP/);

    const registry = readJson(dir, '.factory/checks.json');
    registry.checks.unit = {
      argv: ['dotnet', 'test'],
      cwdPolicy: 'project',
      timeoutMs: 120000,
      artifacts: [],
    };
    fs.writeFileSync(path.join(dir, '.factory/checks.json'), `${JSON.stringify(registry, null, 2)}\n`);
    const config = readJson(dir, '.factory/config.json');
    config.governance.policyVersion = 2;
    delete config.governance.principalVerifier;
    fs.writeFileSync(path.join(dir, '.factory/config.json'), `${JSON.stringify(config, null, 2)}\n`);
    const decisions = fs.readFileSync(path.join(dir, '.factory/decisions.md'), 'utf8');
    const checks = fs.readFileSync(path.join(dir, '.factory/checks.json'), 'utf8');
    const strictGap = await idefactory(dir, ['upgrade']);
    assert.equal(strictGap.code, 0, strictGap.err);
    assert.match(strictGap.out, /missing principal verifier/);
    assert.equal(fs.readFileSync(path.join(dir, '.factory/checks.json'), 'utf8'), checks);
    assert.equal(fs.readFileSync(path.join(dir, '.factory/decisions.md'), 'utf8'), decisions);
  } finally {
    cleanup(dir);
  }
});
