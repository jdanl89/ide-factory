import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { cleanup, idefactory, tempProject } from './helpers.mjs';

test('checks preview suggests a missing unit entry and does not run or write it', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const registryPath = path.join(dir, '.factory/checks.json');
    const before = fs.readFileSync(registryPath, 'utf8');
    const registry = JSON.parse(before);
    delete registry.checks.unit;
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
    const removed = fs.readFileSync(registryPath, 'utf8');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    fs.writeFileSync(path.join(dir, 'ran.txt'), '');
    const profiles = JSON.parse(fs.readFileSync(path.join(dir, '.factory/profiles.json'), 'utf8'));
    profiles['frontend-low'].checks = ['unit'];
    fs.writeFileSync(path.join(dir, '.factory/profiles.json'), JSON.stringify(profiles, null, 2));
    const result = await idefactory(dir, ['checks', 'preview']);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /"unit"/);
    assert.match(result.out, /npm/);
    assert.equal(fs.readFileSync(registryPath, 'utf8'), removed);
    assert.equal(fs.readFileSync(path.join(dir, 'ran.txt'), 'utf8'), '');
  } finally {
    cleanup(dir);
  }
});

test('checks preview does not replace an existing unit entry', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const registryPath = path.join(dir, '.factory/checks.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    registry.checks.unit = {
      argv: ['npm', 'test'],
      cwdPolicy: 'project',
      timeoutMs: 120000,
      artifacts: [],
    };
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
    const before = fs.readFileSync(registryPath, 'utf8');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'echo no' } }));
    const result = await idefactory(dir, ['checks', 'preview']);
    assert.equal(result.code, 0, result.err);
    assert.equal(fs.readFileSync(registryPath, 'utf8'), before);
    assert.doesNotMatch(result.out, /"argv"/);
  } finally {
    cleanup(dir);
  }
});
