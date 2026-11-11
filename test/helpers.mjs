import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/lib/run.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(here, '..');
export const fakeBacklog = path.join(repoRoot, 'support/fake-backlog.mjs');

export function tempProject() {
  return mkdtempSync(path.join(tmpdir(), 'idefactory-'));
}

export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

export async function idefactory(dir, args, extraEnv = {}, io = {}) {
  let out = '';
  let err = '';
  const code = await run([...args, '--path', dir], {
    cwd: dir,
    env: { ...process.env, ...extraEnv },
    isTTY: io.isTTY ?? false,
    stdout: { write(chunk) { out += chunk; return true; } },
    stderr: { write(chunk) { err += chunk; return true; } },
  });
  return { code, out, err };
}
