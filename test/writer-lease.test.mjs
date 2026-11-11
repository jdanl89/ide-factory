import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import * as writerLease from '../src/lib/writer-lease.mjs';
import {
  LEASE_HELD,
  acquireWriterLease,
  isMutatingCommand,
  isReadOnlyCommand,
  readWriterLease,
  releaseWriterLease,
  withReadOnlyCommand,
  withWriterLease,
  writerLeaseDir,
} from '../src/lib/writer-lease.mjs';
import { cleanup, idefactory, tempProject } from './helpers.mjs';

const {
  LEASE_RECOVERY,
  OWNERSHIP_LOST,
  WRITER_LEASE_HEARTBEAT_MS,
  WRITER_LEASE_TTL_MS,
  cliCommandKey,
  renewWriterLease,
} = writerLease;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const leaseModule = pathToFileURL(path.join(repoRoot, 'src/lib/writer-lease.mjs')).href;

function seedFactory(dir) {
  fs.mkdirSync(path.join(dir, '.factory', 'orchestration'), { recursive: true });
}

function ownerPath(dir) {
  return path.join(writerLeaseDir(dir), 'owner.json');
}

function raceAcquireOnce(project) {
  const script = `
import { acquireWriterLease } from ${JSON.stringify(leaseModule)};
try {
  const lease = acquireWriterLease(process.argv[1], 'complete');
  process.stdout.write(JSON.stringify({ ok: true, leaseId: lease.leaseId }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    code: error.code || null,
    message: error.message || String(error),
  }));
  process.exitCode = 1;
}
`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, project], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => {
      let parsed = null;
      try {
        parsed = JSON.parse(out);
      } catch {
        parsed = { ok: false, message: out || err, parseFailed: true };
      }
      resolve({ code, ...parsed, stderr: err });
    });
  });
}

test('schema version 1 owner record is written on acquire', () => {
  const dir = tempProject();
  try {
    seedFactory(dir);
    const before = Date.now();
    const lease = acquireWriterLease(dir, 'complete');
    const after = Date.now();
    assert.equal(lease.schemaVersion, 1);
    assert.equal(typeof lease.leaseId, 'string');
    assert.ok(lease.leaseId.length > 0);
    assert.equal(lease.command, 'complete');
    assert.equal(lease.pid, process.pid);
    assert.equal(typeof lease.hostname, 'string');
    assert.ok(lease.hostname.length > 0);
    const acquiredAt = Date.parse(lease.acquiredAt);
    const expiresAt = Date.parse(lease.expiresAt);
    assert.ok(Number.isFinite(acquiredAt));
    assert.ok(Number.isFinite(expiresAt));
    assert.ok(acquiredAt >= before - 1000);
    assert.ok(acquiredAt <= after + 1000);
    assert.equal(expiresAt - acquiredAt, 5 * 60 * 1000);
    const stored = JSON.parse(fs.readFileSync(ownerPath(dir), 'utf8'));
    assert.deepEqual(stored, lease);
  } finally {
    cleanup(dir);
  }
});

test('atomic lease acquisition has exactly one winner', async () => {
  const dir = tempProject();
  try {
    seedFactory(dir);
    const [a, b] = await Promise.all([raceAcquireOnce(dir), raceAcquireOnce(dir)]);
    const wins = [a, b].filter((r) => r.ok);
    const losses = [a, b].filter((r) => !r.ok);
    assert.equal(wins.length, 1, `expected one winner, got ${JSON.stringify([a, b])}`);
    assert.equal(losses.length, 1);
    assert.equal(losses[0].code, LEASE_HELD);
    assert.match(String(losses[0].message), /lease/i);
    const stored = readWriterLease(dir);
    assert.equal(stored.leaseId, wins[0].leaseId);
  } finally {
    cleanup(dir);
  }
});

test('non-expired owner makes a second writer fail clearly without mutation', async () => {
  const dir = tempProject();
  try {
    seedFactory(dir);
    const marker = path.join(dir, 'mutation.txt');
    await withWriterLease(dir, 'complete', async () => {
      let ran = false;
      await assert.rejects(
        () => withWriterLease(dir, 'approve', async () => {
          ran = true;
          fs.writeFileSync(marker, 'mutated\n');
          return 'should-not-return';
        }),
        (error) => {
          assert.equal(error.code, LEASE_HELD);
          assert.match(String(error.message), /lease/i);
          return true;
        },
      );
      assert.equal(ran, false);
      assert.equal(fs.existsSync(marker), false);
      const owner = readWriterLease(dir);
      assert.equal(owner.command, 'complete');
      assert.ok(Date.parse(owner.expiresAt) > Date.now());
    });
  } finally {
    cleanup(dir);
  }
});

test('success releases only the matching lease id', async () => {
  const dir = tempProject();
  try {
    seedFactory(dir);
    await withWriterLease(dir, 'complete', async () => 'ok');
    assert.equal(fs.existsSync(writerLeaseDir(dir)), false);

    const first = acquireWriterLease(dir, 'complete');
    const successor = {
      ...first,
      leaseId: 'successor-lease-id',
      command: 'approve',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    };
    fs.writeFileSync(ownerPath(dir), `${JSON.stringify(successor, null, 2)}\n`);
    releaseWriterLease(dir, first.leaseId);
    assert.equal(fs.existsSync(writerLeaseDir(dir)), true);
    assert.deepEqual(readWriterLease(dir), successor);
    releaseWriterLease(dir, successor.leaseId);
    assert.equal(fs.existsSync(writerLeaseDir(dir)), false);
  } finally {
    cleanup(dir);
  }
});

test('handled errors release only the matching lease id', async () => {
  const dir = tempProject();
  try {
    seedFactory(dir);
    await assert.rejects(
      () => withWriterLease(dir, 'complete', async () => {
        throw new Error('handled boom');
      }),
      /handled boom/,
    );
    assert.equal(fs.existsSync(writerLeaseDir(dir)), false);

    const first = acquireWriterLease(dir, 'next');
    const successor = {
      ...first,
      leaseId: 'error-successor-id',
      command: 'run',
    };
    fs.writeFileSync(ownerPath(dir), `${JSON.stringify(successor, null, 2)}\n`);
    // Simulate an owner that still holds a stale handle after succession.
    releaseWriterLease(dir, first.leaseId);
    assert.equal(fs.existsSync(writerLeaseDir(dir)), true);
    assert.equal(readWriterLease(dir).leaseId, 'error-successor-id');
  } finally {
    cleanup(dir);
  }
});

test('read-only commands neither acquire nor remove a lease', async () => {
  const dir = tempProject();
  try {
    seedFactory(dir);
    assert.equal(isReadOnlyCommand('status'), true);
    assert.equal(isReadOnlyCommand('doctor'), true);
    assert.equal(isReadOnlyCommand('help'), true);
    assert.equal(isReadOnlyCommand('attempt show'), true);
    assert.equal(isMutatingCommand('status'), false);
    assert.equal(isMutatingCommand('complete'), true);
    assert.equal(isMutatingCommand('attempt start'), true);

    await withReadOnlyCommand(dir, 'status', async () => {
      assert.equal(fs.existsSync(writerLeaseDir(dir)), false);
      return 'status-ok';
    });
    assert.equal(fs.existsSync(writerLeaseDir(dir)), false);

    const lease = acquireWriterLease(dir, 'complete');
    const before = readWriterLease(dir);
    const result = await withReadOnlyCommand(dir, 'doctor', async () => 'doctor-ok');
    assert.equal(result, 'doctor-ok');
    assert.deepEqual(readWriterLease(dir), before);
    assert.equal(fs.existsSync(writerLeaseDir(dir)), true);
    assert.equal(readWriterLease(dir).leaseId, lease.leaseId);

    await withReadOnlyCommand(dir, 'attempt show', async () => 'show-ok');
    assert.deepEqual(readWriterLease(dir), before);
  } finally {
    cleanup(dir);
  }
});

test('hostname is recorded from the local machine', () => {
  const dir = tempProject();
  try {
    seedFactory(dir);
    const lease = acquireWriterLease(dir, 'init');
    assert.equal(lease.hostname, os.hostname());
  } finally {
    cleanup(dir);
  }
});

function createFakeClock(startMs = 1_700_000_000_000) {
  let now = startMs;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    },
  };
}

function writeOwner(dir, owner) {
  const leaseDir = writerLeaseDir(dir);
  fs.mkdirSync(leaseDir, { recursive: true });
  fs.writeFileSync(ownerPath(dir), `${JSON.stringify(owner, null, 2)}\n`);
}

function raceAcquireWithNow(project, nowMs) {
  const script = `
import { acquireWriterLease } from ${JSON.stringify(leaseModule)};
try {
  const lease = acquireWriterLease(process.argv[1], 'complete', { now: () => Number(process.argv[2]) });
  process.stdout.write(JSON.stringify({ ok: true, leaseId: lease.leaseId }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    code: error.code || null,
    message: error.message || String(error),
  }));
  process.exitCode = 1;
}
`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, project, String(nowMs)], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => {
      let parsed = null;
      try {
        parsed = JSON.parse(out);
      } catch {
        parsed = { ok: false, message: out || err, parseFailed: true };
      }
      resolve({ code, ...parsed, stderr: err });
    });
  });
}

test('fake clock heartbeat renews expiry once per minute while lease id matches', async () => {
  const dir = tempProject();
  try {
    seedFactory(dir);
    assert.equal(WRITER_LEASE_HEARTBEAT_MS, 60_000);
    assert.equal(WRITER_LEASE_TTL_MS, 5 * 60_000);
    const clock = createFakeClock();
    /** @type {{ fn: () => void, ms: number }[]} */
    const scheduled = [];
    const handle = { id: 1 };
    await withWriterLease(
      dir,
      'complete',
      async (lease) => {
        assert.equal(scheduled.length, 1);
        assert.equal(scheduled[0].ms, WRITER_LEASE_HEARTBEAT_MS);
        const acquiredExpiry = Date.parse(lease.expiresAt);
        assert.equal(acquiredExpiry, clock.now() + WRITER_LEASE_TTL_MS);

        clock.advance(WRITER_LEASE_HEARTBEAT_MS);
        scheduled[0].fn();
        const renewed = readWriterLease(dir);
        assert.equal(renewed.leaseId, lease.leaseId);
        assert.equal(Date.parse(renewed.expiresAt), clock.now() + WRITER_LEASE_TTL_MS);
        assert.ok(Date.parse(renewed.expiresAt) > acquiredExpiry);

        assert.equal(
          renewWriterLease(dir, lease.leaseId, { now: clock.now }),
          true,
        );
        return 'ok';
      },
      {
        now: clock.now,
        heartbeatIntervalMs: WRITER_LEASE_HEARTBEAT_MS,
        setInterval: (fn, ms) => {
          scheduled.push({ fn, ms });
          return handle;
        },
        clearInterval: (token) => {
          assert.equal(token, handle);
        },
      },
    );
    assert.equal(fs.existsSync(writerLeaseDir(dir)), false);
  } finally {
    cleanup(dir);
  }
});

test('five-minute expiry allows one-winner atomic stale-directory takeover', async () => {
  const dir = tempProject();
  try {
    seedFactory(dir);
    const clock = createFakeClock();
    const first = acquireWriterLease(dir, 'complete', { now: clock.now, leaseId: 'expired-owner' });
    assert.equal(Date.parse(first.expiresAt) - Date.parse(first.acquiredAt), WRITER_LEASE_TTL_MS);

    clock.advance(WRITER_LEASE_TTL_MS - 1);
    await assert.rejects(
      async () => acquireWriterLease(dir, 'approve', { now: clock.now }),
      (error) => {
        assert.equal(error.code, LEASE_HELD);
        return true;
      },
    );
    assert.equal(readWriterLease(dir).leaseId, 'expired-owner');

    clock.advance(2);
    const nowMs = clock.now();
    const [a, b] = await Promise.all([
      raceAcquireWithNow(dir, nowMs),
      raceAcquireWithNow(dir, nowMs),
    ]);
    const wins = [a, b].filter((r) => r.ok);
    const losses = [a, b].filter((r) => !r.ok);
    assert.equal(wins.length, 1, `expected one takeover winner, got ${JSON.stringify([a, b])}`);
    assert.equal(losses.length, 1);
    assert.equal(losses[0].code, LEASE_HELD);
    const stored = readWriterLease(dir);
    assert.equal(stored.leaseId, wins[0].leaseId);
    assert.notEqual(stored.leaseId, 'expired-owner');
    const staleDirs = fs.readdirSync(path.join(dir, '.factory', 'orchestration'))
      .filter((name) => name.startsWith('writer.lease.stale-'));
    assert.equal(staleDirs.length, 0, 'winner removes its stale tombstone');
  } finally {
    cleanup(dir);
  }
});

test('stale takeover treats a vanished lease directory as LEASE_HELD not LEASE_RECOVERY', () => {
  const dir = tempProject();
  try {
    seedFactory(dir);
    const clock = createFakeClock();
    acquireWriterLease(dir, 'complete', { now: clock.now, leaseId: 'expire-me' });
    clock.advance(WRITER_LEASE_TTL_MS + 1);
    const leaseDir = writerLeaseDir(dir);
    const ownerFile = path.join(leaseDir, 'owner.json');
    const origRead = fs.readFileSync;
    let ownerReads = 0;
    fs.readFileSync = function patchedReadFileSync(p, enc) {
      if (path.resolve(String(p)) === path.resolve(ownerFile)) {
        ownerReads += 1;
        if (ownerReads === 1) {
          const data = origRead.call(fs, p, enc);
          if (fs.existsSync(leaseDir)) {
            fs.renameSync(leaseDir, `${leaseDir}.stale-simulated`);
          }
          return data;
        }
      }
      return origRead.call(fs, p, enc);
    };
    try {
      assert.throws(
        () => acquireWriterLease(dir, 'approve', { now: clock.now }),
        (error) => {
          assert.equal(error.code, LEASE_HELD);
          return true;
        },
      );
    } finally {
      fs.readFileSync = origRead;
    }
  } finally {
    cleanup(dir);
  }
});

test('atomic publication never exposes writer.lease without owner.json; gap contender gets LEASE_HELD', () => {
  const dir = tempProject();
  try {
    seedFactory(dir);
    const leaseDir = writerLeaseDir(dir);
    /** @type {string[]} */
    const gaps = [];
    /** @type {string|null} */
    let gapContenderCode = null;
    const clock = createFakeClock();
    const origMkdir = fs.mkdirSync;
    fs.mkdirSync = function patchedMkdirSync(p, opts) {
      const result = origMkdir.call(fs, p, opts);
      if (path.resolve(String(p)) !== path.resolve(leaseDir)) return result;
      if (fs.existsSync(path.join(leaseDir, 'owner.json'))) return result;
      gaps.push('final lease directory visible without owner.json');
      if (gapContenderCode === null) {
        try {
          acquireWriterLease(dir, 'reject', { now: clock.now });
          gapContenderCode = 'UNEXPECTED_OK';
        } catch (error) {
          gapContenderCode = error.code || 'NO_CODE';
        }
      }
      return result;
    };
    try {
      acquireWriterLease(dir, 'complete', { now: clock.now, leaseId: 'publish-first' });
      clock.advance(WRITER_LEASE_TTL_MS + 1);
      acquireWriterLease(dir, 'approve', { now: clock.now, leaseId: 'publish-second' });
    } finally {
      fs.mkdirSync = origMkdir;
    }
    assert.equal(
      gaps.length,
      0,
      `lease directory must become visible only with owner.json; gaps=${gaps.length} contender=${gapContenderCode}`,
    );
    if (gapContenderCode !== null) {
      assert.equal(gapContenderCode, LEASE_HELD);
    }
    assert.equal(readWriterLease(dir).leaseId, 'publish-second');
  } finally {
    cleanup(dir);
  }
});

test('owner-loss after heartbeat mismatch rejects success', async () => {
  const dir = tempProject();
  try {
    seedFactory(dir);
    const clock = createFakeClock();
    /** @type {{ fn: () => void }[]} */
    const scheduled = [];
    await assert.rejects(
      () => withWriterLease(
        dir,
        'complete',
        async (lease) => {
          const successor = {
            ...lease,
            leaseId: 'takeover-id',
            command: 'approve',
            acquiredAt: new Date(clock.now()).toISOString(),
            expiresAt: new Date(clock.now() + WRITER_LEASE_TTL_MS).toISOString(),
          };
          const stale = `${writerLeaseDir(dir)}.stale-test`;
          fs.renameSync(writerLeaseDir(dir), stale);
          fs.mkdirSync(writerLeaseDir(dir));
          fs.writeFileSync(ownerPath(dir), `${JSON.stringify(successor, null, 2)}\n`);
          fs.rmSync(stale, { recursive: true, force: true });
          clock.advance(WRITER_LEASE_HEARTBEAT_MS);
          scheduled[0].fn();
          return 'should-not-succeed';
        },
        {
          now: clock.now,
          setInterval: (fn) => {
            scheduled.push({ fn });
            return 1;
          },
          clearInterval: () => {},
        },
      ),
      (error) => {
        assert.equal(error.code, OWNERSHIP_LOST);
        assert.match(String(error.message), /ownership lost|lease/i);
        return true;
      },
    );
    assert.equal(readWriterLease(dir).leaseId, 'takeover-id');
  } finally {
    cleanup(dir);
  }
});

test('corrupt or unsupported lease refuses recovery without deleting the record', async () => {
  const dir = tempProject();
  try {
    seedFactory(dir);
    writeOwner(dir, { schemaVersion: 99, leaseId: 'bad-schema' });
    await assert.rejects(
      async () => acquireWriterLease(dir, 'complete'),
      (error) => {
        assert.equal(error.code, LEASE_RECOVERY);
        assert.match(String(error.message), /lease|recovery|schema/i);
        return true;
      },
    );
    assert.equal(fs.existsSync(writerLeaseDir(dir)), true);
    assert.equal(JSON.parse(fs.readFileSync(ownerPath(dir), 'utf8')).schemaVersion, 99);

    fs.writeFileSync(ownerPath(dir), '{not-json');
    await assert.rejects(
      async () => acquireWriterLease(dir, 'next'),
      (error) => {
        assert.equal(error.code, LEASE_RECOVERY);
        return true;
      },
    );
    assert.equal(fs.readFileSync(ownerPath(dir), 'utf8'), '{not-json');
  } finally {
    cleanup(dir);
  }
});

test('HALT bypasses the writer lease without stealing or deleting it', async () => {
  const dir = tempProject();
  try {
    seedFactory(dir);
    const lease = acquireWriterLease(dir, 'complete');
    const before = readWriterLease(dir);
    const halted = await idefactory(dir, ['halt']);
    assert.equal(halted.code, 0);
    assert.equal(fs.existsSync(path.join(dir, 'HALT')), true);
    assert.deepEqual(readWriterLease(dir), before);
    assert.equal(readWriterLease(dir).leaseId, lease.leaseId);
  } finally {
    cleanup(dir);
  }
});

test('CLI wraps each mutating command once at top level; read-only stays unleased', async () => {
  const dir = tempProject();
  try {
    seedFactory(dir);
    const mutating = [
      ['init'],
      ['upgrade'],
      ['sync-tasks', 'demo'],
      ['next'],
      ['run', '--change', 'demo'],
      ['attempt', 'start', 'demo', '1.1'],
      ['attempt', 'transition', '00000000-0000-4000-8000-000000000001', 'implementing'],
      ['verify', 'run', '00000000-0000-4000-8000-000000000001', '--check', 'unit'],
      ['verify', 'import', '00000000-0000-4000-8000-000000000001', '--file', 'missing.json'],
      ['complete', 'demo', '1.1', '--attempt', '00000000-0000-4000-8000-000000000001'],
      ['approve', 'note-1', '--note', 'ok', '--change', 'demo', '--task', '1.1', '--action', 'accept', '--approver', 'a1', '--expiry', '2099-01-01T00:00:00.000Z'],
      ['reject', 'note-1', '--note', 'no'],
      ['lockout', 'create', '--agent', 'a1', '--reviewer', 'r1', '--reason', 'block'],
      ['lockout', 'resolve', 'lock-1', '--resolver', 'r2', '--reason', 'clear'],
      ['resume'],
      ['setup', '--governance', 'lightweight', '--no-test'],
    ];
    for (const args of mutating) {
      assert.equal(isMutatingCommand(cliCommandKey(args[0], args.slice(1))), true, args.join(' '));
    }
    assert.equal(isReadOnlyCommand(cliCommandKey('status')), true);
    assert.equal(isReadOnlyCommand(cliCommandKey('doctor')), true);
    assert.equal(isReadOnlyCommand(cliCommandKey('help')), true);
    assert.equal(isReadOnlyCommand(cliCommandKey('attempt', ['show', 'x'])), true);
    assert.equal(isReadOnlyCommand(cliCommandKey('setup', [], { detect: true })), true);
    assert.equal(isMutatingCommand(cliCommandKey('setup', [], { detect: true })), false);
    assert.equal(isMutatingCommand(cliCommandKey('halt')), false);

    const lease = acquireWriterLease(dir, 'complete', { leaseId: 'cli-holder' });
    const marker = path.join(dir, '.factory', 'orchestration', 'mutation-marker.txt');
    fs.writeFileSync(marker, 'before\n');

    for (const args of mutating) {
      const result = await idefactory(dir, args);
      assert.equal(result.code, 1, `expected lease-held for ${args.join(' ')}; out=${result.out} err=${result.err}`);
      assert.match(`${result.err}${result.out}`, /lease/i);
      assert.equal(readWriterLease(dir).leaseId, 'cli-holder');
    }

    const held = readWriterLease(dir);
    const status = await idefactory(dir, ['status']);
    assert.doesNotMatch(`${status.err}${status.out}`, /lease held/i);
    assert.deepEqual(readWriterLease(dir), held);

    const doctor = await idefactory(dir, ['doctor']);
    assert.doesNotMatch(`${doctor.err}${doctor.out}`, /lease held/i);
    assert.deepEqual(readWriterLease(dir), held);

    const show = await idefactory(dir, ['attempt', 'show', '00000000-0000-4000-8000-000000000001']);
    assert.doesNotMatch(`${show.err}${show.out}`, /lease held/i);
    assert.deepEqual(readWriterLease(dir), held);

    assert.equal(fs.readFileSync(marker, 'utf8'), 'before\n');
    releaseWriterLease(dir, lease.leaseId);
  } finally {
    cleanup(dir);
  }
});

test('release uses rename so a concurrent stale takeover cannot delete the successor lease', () => {
  const dir = tempProject();
  try {
    seedFactory(dir);
    const clock = createFakeClock();
    const first = acquireWriterLease(dir, 'complete', {
      now: clock.now,
      leaseId: 'original-release',
    });
    clock.advance(WRITER_LEASE_TTL_MS + 1);
    const successor = acquireWriterLease(dir, 'approve', {
      now: clock.now,
      leaseId: 'successor-after-takeover',
    });
    assert.equal(successor.leaseId, 'successor-after-takeover');
    assert.equal(releaseWriterLease(dir, first.leaseId), false);
    assert.equal(readWriterLease(dir).leaseId, 'successor-after-takeover');
    assert.equal(releaseWriterLease(dir, successor.leaseId), true);
    assert.equal(fs.existsSync(writerLeaseDir(dir)), false);
  } finally {
    cleanup(dir);
  }
});
