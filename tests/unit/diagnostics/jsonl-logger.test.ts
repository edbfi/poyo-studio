import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, readdir, rename, stat, symlink, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  type LoggerFileOperations,
  StructuredLogger
} from '../../../src/lib/server/diagnostics/jsonl-logger';
import { MaintenanceGate } from '../../../src/lib/server/platform/maintenance-gate';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('structured JSONL logging', () => {
  test('LOG-01 separates errors, redacts records, and bounds size rotation retention', async () => {
    const temporary = await createTemporaryDirectory('poyo-log-');
    cleanups.push(temporary.cleanup);
    const secret = 'sk-test_log_canary_123456789';
    const logger = new StructuredLogger({
      directory: temporary.path,
      maxBytes: 220,
      maxRotatedFiles: 2,
      retentionAgeMs: Number.MAX_SAFE_INTEGER
    });

    for (let index = 0; index < 7; index += 1) {
      await logger.info('generation.observed', {
        correlationId: `correlation-${index}`,
        data: { authorization: `Bearer ${secret}`, message: 'x'.repeat(100) }
      });
    }
    await logger.error('generation.failed', new Error(`failure ${secret}`));

    const names = await readdir(temporary.path);
    const rotated = names.filter((name) => name.startsWith('app.jsonl.'));
    const contents = await Promise.all(
      names.map((name) => Bun.file(join(temporary.path, name)).text())
    );

    expect(rotated.length).toBeLessThanOrEqual(2);
    expect(names).toContain('app.jsonl');
    expect(names).toContain('error.jsonl');
    const combined = contents.join('');
    expect(combined).not.toContain(secret);
    for (const algorithm of ['sha1', 'sha256', 'sha384', 'sha512'] as const) {
      expect(combined).not.toContain(new Bun.CryptoHasher(algorithm).update(secret).digest('hex'));
    }
    for (const line of contents.join('').trim().split('\n'))
      expect(() => JSON.parse(line)).not.toThrow();
  });

  test('survives rotation failures and exposes only a safe degraded diagnostic', async () => {
    const temporary = await createTemporaryDirectory('poyo-log-failure-');
    cleanups.push(temporary.cleanup);
    let rotationErrors = 0;
    const files: LoggerFileOperations = {
      append: (path, content) => appendFile(path, content, 'utf8'),
      canonicalize: (path) => Promise.resolve(path),
      captureDirectory: () => Promise.resolve(null),
      list: (path) => readdir(path),
      mkdir: async (path) => mkdir(path, { recursive: true }).then(() => undefined),
      remove: (path) => unlink(path),
      removeTree: () => Promise.resolve(),
      rename: () =>
        Promise.reject(
          new Error(`EACCES: rename ${temporary.path}/app.jsonl -> ${temporary.path}/app.rotated`)
        ),
      stat: async (path) => {
        try {
          const info = await stat(path);
          return {
            size: info.size,
            mtimeMs: info.mtimeMs,
            isFile: info.isFile(),
            isDirectory: info.isDirectory(),
            isSymbolicLink: false
          };
        } catch {
          return null;
        }
      }
    };
    const logger = new StructuredLogger({
      directory: temporary.path,
      maxBytes: 1,
      files,
      onRotationError: () => {
        rotationErrors += 1;
      }
    });

    await logger.info('first');
    await logger.info('second');
    const diagnostics = await logger.diagnostics();
    expect(rotationErrors).toBe(1);
    expect(diagnostics.status).toBe('degraded');
    expect(diagnostics.lastRotationError).toEqual({
      name: 'Error',
      message: 'Log rotation failed.'
    });
    expect(JSON.stringify(diagnostics)).not.toContain(temporary.path);
    expect(
      (await Bun.file(join(temporary.path, 'app.jsonl')).text()).trim().split('\n')
    ).toHaveLength(2);
  });

  test('applies validated runtime rotation settings without recreating the logger', () => {
    const logger = new StructuredLogger({ directory: '/tmp/poyo-test-logs' });
    logger.updateRotationSettings({
      separateErrorFile: false,
      maxBytes: 65_536,
      maxAgeMs: 60_000,
      retentionAgeMs: 3_600_000,
      maxRotatedFiles: 4
    });
    expect(logger.rotationSettings()).toEqual({
      separateErrorFile: false,
      maxBytes: 65_536,
      maxAgeMs: 60_000,
      retentionAgeMs: 3_600_000,
      maxRotatedFiles: 4
    });
    expect(() =>
      logger.updateRotationSettings({
        separateErrorFile: true,
        maxBytes: 0,
        maxAgeMs: 1,
        retentionAgeMs: 1,
        maxRotatedFiles: 1
      })
    ).toThrow('supported bounds');
  });

  test('enforces one suspend and resume cycle for an exclusive maintenance lease', async () => {
    const temporary = await createTemporaryDirectory('poyo-log-maintenance-');
    cleanups.push(temporary.cleanup);
    const gate = new MaintenanceGate();
    const logger = new StructuredLogger({ directory: temporary.path, gate });
    gate.registerDrain('structured-logger', () => logger.suspendAndDrain());

    await logger.info('before-maintenance');
    const lease = await gate.upgradeToExclusiveMaintenance(
      gate.acquireMaintenanceInitiator('credential-switch')
    );

    await expect(logger.info('during-maintenance')).rejects.toThrow(
      'Logger is suspended for maintenance.'
    );
    logger.resumeBeforePublication();
    lease.reopenBeforePublication();
    await logger.info('after-maintenance');
    expect(await Bun.file(join(temporary.path, 'app.jsonl')).text()).toContain('after-maintenance');
    expect(() => logger.resumeBeforePublication()).toThrow('Logger is not suspended.');
  });

  test('atomically clears the dedicated log directory and resumes normal logging', async () => {
    const temporary = await createTemporaryDirectory('poyo-log-clear-');
    cleanups.push(temporary.cleanup);
    const logger = new StructuredLogger({ directory: temporary.path });

    await logger.info('before-clear');
    await logger.error('before-clear-error', new Error('safe failure'));
    await Bun.write(join(temporary.path, 'injected-file.txt'), 'owned log-directory data');
    await expect(logger.clearManagedFiles()).rejects.toThrow('must be suspended');

    await logger.suspendAndDrain();
    expect(await logger.clearManagedFiles()).toEqual({ cleared: true });
    expect(await readdir(temporary.path)).toEqual([]);

    logger.resumeBeforePublication();
    await logger.info('after-clear');
    expect(await Bun.file(join(temporary.path, 'app.jsonl')).text()).toContain('after-clear');
  });

  test('propagates a failed atomic directory capture without reporting deletion', async () => {
    const files: LoggerFileOperations = {
      append: () => Promise.resolve(),
      canonicalize: (path) => Promise.resolve(path),
      captureDirectory: () => Promise.reject(new Error('injected capture failure')),
      list: () => Promise.resolve([]),
      mkdir: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      removeTree: () => Promise.resolve(),
      rename: () => Promise.resolve(),
      stat: () => Promise.resolve(null)
    };
    const logger = new StructuredLogger({ directory: '/poyo-log-clear-fake', files });

    await logger.suspendAndDrain();
    await expect(logger.clearManagedFiles()).rejects.toThrow('injected capture failure');
  });

  test('retries an interrupted captured-log deletion during startup recovery', async () => {
    const temporary = await createTemporaryDirectory('poyo-log-recovery-');
    cleanups.push(temporary.cleanup);
    const configured = join(temporary.path, 'logs');
    const captured = join(temporary.path, `.logs.clear-${randomUUID()}`);
    await mkdir(configured);
    await Bun.write(join(configured, 'app.jsonl'), 'pending deletion');
    await rename(configured, captured);
    await mkdir(configured);

    const logger = new StructuredLogger({ directory: configured });
    await logger.recoverPendingClears();

    expect(await Bun.file(captured).exists()).toBe(false);
    const replacement = await lstat(configured);
    expect(replacement.isDirectory()).toBe(true);
    expect(replacement.isSymbolicLink()).toBe(false);
  });

  test('does not report success while a captured-log deletion remains pending', async () => {
    const directory = '/private-root/logs';
    const captured = join(dirname(directory), `.logs.clear-${randomUUID()}`);
    let captureCalls = 0;
    let pending = false;
    let failRemoval = true;
    const files: LoggerFileOperations = {
      append: () => Promise.resolve(),
      canonicalize: (path) => Promise.resolve(path),
      captureDirectory: () => {
        captureCalls += 1;
        if (captureCalls > 1) return Promise.resolve(null);
        pending = true;
        return Promise.resolve(captured);
      },
      list: (path) =>
        Promise.resolve(path === dirname(directory) && pending ? [basename(captured)] : []),
      mkdir: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      removeTree: () => {
        if (failRemoval) return Promise.reject(new Error('injected removal failure'));
        pending = false;
        return Promise.resolve();
      },
      rename: () => Promise.resolve(),
      stat: () => Promise.resolve(null)
    };
    const logger = new StructuredLogger({ directory, files });

    await logger.suspendAndDrain();
    await expect(logger.clearManagedFiles()).rejects.toThrow('injected removal failure');
    expect(pending).toBe(true);

    failRemoval = false;
    await expect(logger.clearManagedFiles()).resolves.toEqual({ cleared: true });
    expect(pending).toBe(false);
  });

  test('captures a replaced log-directory link without traversing its target', async () => {
    const temporary = await createTemporaryDirectory('poyo-log-clear-symlink-');
    cleanups.push(temporary.cleanup);
    const configured = join(temporary.path, 'logs');
    const displaced = join(temporary.path, 'logs-displaced');
    const outside = join(temporary.path, 'outside');
    await mkdir(configured);
    await mkdir(outside);
    await Bun.write(join(outside, 'app.jsonl'), 'outside');
    await rename(configured, displaced);
    await symlink(outside, configured, 'dir');

    const logger = new StructuredLogger({ directory: configured });
    await logger.suspendAndDrain();

    expect(await logger.clearManagedFiles()).toEqual({ cleared: true });
    expect(await Bun.file(join(outside, 'app.jsonl')).exists()).toBe(true);
    const replacement = await lstat(configured);
    expect(replacement.isDirectory()).toBe(true);
    expect(replacement.isSymbolicLink()).toBe(false);
  });
});
