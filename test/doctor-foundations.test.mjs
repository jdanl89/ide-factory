import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { cleanup, idefactory, tempProject } from './helpers.mjs';

function readJson(dir, rel) {
  return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
}

test('doctor fails when the test decision or a strict verifier is missing', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const missingTest = await idefactory(dir, ['doctor']);
    assert.notEqual(missingTest.code, 0);
    assert.match(missingTest.out, /missing test decision/);

    const registry = readJson(dir, '.factory/checks.json');
    registry.checks.unit = {
      argv: ['dotnet', 'test'],
      cwdPolicy: 'project',
      timeoutMs: 120000,
      artifacts: [],
    };
    fs.writeFileSync(path.join(dir, '.factory/checks.json'), JSON.stringify(registry, null, 2));
    const config = readJson(dir, '.factory/config.json');
    config.governance.policyVersion = 2;
    delete config.governance.principalVerifier;
    fs.writeFileSync(path.join(dir, '.factory/config.json'), JSON.stringify(config, null, 2));
    const missingVerifier = await idefactory(dir, ['doctor']);
    assert.notEqual(missingVerifier.code, 0);
    assert.match(missingVerifier.out, /missing principal verifier/);
  } finally {
    cleanup(dir);
  }
});

test('doctor stays quiet for policy version 1 when a test command is mapped', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const registry = readJson(dir, '.factory/checks.json');
    registry.checks.unit = {
      argv: ['dotnet', 'test'],
      cwdPolicy: 'project',
      timeoutMs: 120000,
      artifacts: [],
    };
    fs.writeFileSync(path.join(dir, '.factory/checks.json'), JSON.stringify(registry, null, 2));
    const profiles = readJson(dir, '.factory/profiles.json');
    profiles['frontend-low'].checks = ['unit', 'custom-kind'];
    fs.writeFileSync(path.join(dir, '.factory/profiles.json'), JSON.stringify(profiles, null, 2));
    const result = await idefactory(dir, ['doctor']);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /policy version: 1/);
    assert.doesNotMatch(`${result.out}${result.err}`, /not bound to a verified principal/);
    assert.match(`${result.out}${result.err}`, /custom-kind/);
  } finally {
    cleanup(dir);
  }
});
