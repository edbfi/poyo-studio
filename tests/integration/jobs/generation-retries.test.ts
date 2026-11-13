import { afterEach, describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { batchStateForJob, isJob } from '../../../src/lib/features/generation/studio-batch';
import {
  applyStudioJobEvent,
  latestSuccessfulStudioJob,
  mergeKnownStudioSnapshot
} from '../../../src/lib/features/generation/studio-session';
import { statusTone } from '../../../src/lib/features/library/presentation';
import { PRICING_SIGNATURE_VERSION } from '../../../src/lib/features/pricing/contracts';
import { CleanupRepository } from '../../../src/lib/server/cleanup/repository';
import { JobCoordinator } from '../../../src/lib/server/jobs/coordinator';
import { OutputDownloader } from '../../../src/lib/server/jobs/downloader';
import {
  decodeEventChunk,
  initialJobEvents,
  safeJobDto
} from '../../../src/lib/server/jobs/events';
import { jobHttpError } from '../../../src/lib/server/jobs/http';
import { JobRepository } from '../../../src/lib/server/jobs/repository';
import { runtimeOperationsSettings } from '../../../src/lib/server/jobs/runtime-settings';
import { studioOutputMetadata } from '../../../src/lib/server/jobs/studio-output-metadata';
import { LibraryRepository } from '../../../src/lib/server/library/repository';
import { openDatabase } from '../../../src/lib/server/platform/database';
import { normalizePoyoError, PoyoError } from '../../../src/lib/server/poyo/errors';
import { parseStatusResponse, parseSubmitResponse } from '../../../src/lib/server/poyo/parsers';
import { seedImageRegistry } from '../../../src/lib/server/registry/repository';
import {
  DEFAULT_OPERATIONS_SETTINGS,
  normalizeOperationsSettings
} from '../../../src/lib/server/settings/operations-settings';
import { SettingsRepository } from '../../../src/lib/server/settings/settings-repository';
import evidence from '../../fixtures/poyo/rejection-diagnostics.json';
import { createJobFixture } from '../../helpers/job-fixture';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup(enabled = true, maxRetries = 3) {
  const fixture = await createJobFixture();
  cleanups.push(fixture.cleanup);
  seedImageRegistry(fixture.database);
  let now = new Date('2026-07-15T12:00:00Z');
  const settings = new SettingsRepository(fixture.database);
  settings.set('operations', {
    ...DEFAULT_OPERATIONS_SETTINGS,
    generationRetries: { enabled, maxRetries }
  });
  return {
    ...fixture,
    settings,
    now: () => now,
    advance: (ms = 3000) => {
      now = new Date(now.getTime() + ms);
      fixture.setNow(now);
    }
  };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
function create(f: Fixture, seed?: number, asset?: string) {
  return f.repository.create({
    actionId: crypto.randomUUID(),
    entryKey: asset ? 'flux-dev:image-edit' : 'flux-dev:text-to-image',
    workflow: asset ? 'image-edit' : 'text-to-image',
    publicModelId: 'flux-dev',
    guidedRequest: { prompt: 'unchanged prompt', ...(seed === undefined ? {} : { seed }) },
    normalizedPayload: {
      model: 'flux-dev',
      input: {
        prompt: 'unchanged prompt',
        enable_safety_checker: false,
        moderation: 'original',
        n: 1,
        ...(seed === undefined ? {} : { seed }),
        ...(asset
          ? {
              image_urls: ['https://source.test/original.png'],
              expert_same_string: 'https://source.test/original.png'
            }
          : {})
      }
    },
    expertDiff: [{ key: 'moderation', value: 'original', status: 'accepted' }],
    estimatedCredits: 5,
    ...(asset
      ? {
          inputs: [
            {
              role: 'reference',
              mediaKind: 'image' as const,
              source: 'uploaded' as const,
              url: 'https://source.test/original.png',
              managedSourceId: asset
            }
          ]
        }
      : {})
  });
}
function accept(f: Fixture, id: string, repo = f.repository) {
  const claim = repo.claimSubmission(id, 'submit-worker', 60000);
  if (!claim) throw new Error('Missing submit claim');
  expect(repo.markSubmissionTransmitted(id, claim.token)).toBe(true);
  repo.acknowledgeSubmission(id, claim.token, {
    taskId: `task-${id}`,
    status: 'running',
    statusRaw: 'running',
    createdTime: 'now'
  });
  return claim;
}
function rejection(id: string) {
  return parseStatusResponse(
    {
      ...evidence.documentedFailedStatus,
      data: { ...evidence.documentedFailedStatus.data, task_id: `task-${id}` }
    },
    200
  );
}
function fail(f: Fixture, id: string, repo = f.repository) {
  return repo.applyStatus(id, rejection(id), 1000);
}
async function child(f: Fixture, owner = 'retry-worker', repo = f.repository) {
  f.advance();
  const claim = repo.claimAutomaticRetry(owner, 1000);
  if (!claim) throw new Error('Missing reservation');
  const job = await repo.fulfillAutomaticRetry(claim, async () => {
    throw new Error('Unexpected managed upload');
  });
  repo.releaseAutomaticRetry(claim);
  if (!job) throw new Error('Missing retry child');
  return job;
}
function managed(f: Fixture) {
  const id = crypto.randomUUID();
  f.database
    .query(
      `INSERT INTO managed_sources(id,original_name,media_kind,mime_type,byte_size,checksum,signature,relative_path,availability,created_at,last_verified_at) VALUES (?,?,'image','image/png',8,'checksum','89504e47',?,'available',?,?)`
    )
    .run(id, 'retained.png', `${id}.png`, f.now().toISOString(), f.now().toISOString());
  return id;
}

describe('exact documented authoritative polled rejection retries', () => {
  test('defaults off; default three means four total paid attempts; custom limits are exact', async () => {
    for (const [enabled, limit] of [
      [false, 3],
      [true, 3],
      [true, 1],
      [true, 5]
    ] as const) {
      const f = await setup(enabled, limit);
      let job = create(f, 1234);
      const original = job.normalizedPayload;
      let submissions = 0;
      for (let ordinal = 0; ordinal <= limit; ordinal++) {
        accept(f, job.id);
        submissions++;
        fail(f, job.id);
        expect(f.repository.get(job.id)?.remoteStatus).toBe('failed');
        expect(f.repository.get(job.id)?.localPhase).toBe('complete');
        if (!enabled || ordinal === limit) break;
        const parent = job;
        job = await child(f);
        expect(job).toMatchObject({
          retryOfJobId: null,
          automaticRetry: {
            rootId: f.repository.list().find((j) => j.automaticRetry?.ordinal === 0)?.id,
            parentId: parent.id,
            ordinal: ordinal + 1,
            maxRetries: limit
          }
        });
        expect(job.normalizedPayload).toEqual(original);
        expect(job.expertDiff).toEqual(parent.expertDiff);
      }
      expect(submissions).toBe(enabled ? limit + 1 : 1);
      expect(
        f.database
          .query(
            "SELECT * FROM generation_retry_reservations WHERE state IN ('pending','refreshing')"
          )
          .all()
      ).toHaveLength(0);
      if (enabled) expect(f.repository.get(job.id)?.automaticRetry?.state).toBe('exhausted');
    }
  });
  test('unknown/reworded/cancelled/charged/outputs/task-mismatch and late observations are ineligible', async () => {
    const f = await setup();
    const mutations = [
      { statusRaw: 'cancelled' },
      { statusRaw: 'canceled' },
      { errorMessage: 'The prompt violates our content policy.' },
      { errorMessage: null },
      { creditsAmount: 1 },
      { creditsAmount: null },
      { taskId: 'another-task' },
      {
        files: [
          {
            url: 'https://media.test/a.png',
            fileType: 'image',
            label: null,
            format: null,
            contentType: null,
            fileName: null,
            fileSize: null
          }
        ]
      }
    ];
    for (const mutation of mutations) {
      const job = create(f);
      accept(f, job.id);
      f.repository.applyStatus(job.id, { ...rejection(job.id), ...mutation }, 1000);
    }
    const late = create(f);
    accept(f, late.id);
    f.repository.applyStatus(
      late.id,
      parseStatusResponse(
        {
          data: {
            ...evidence.documentedFailedStatus.data,
            task_id: `task-${late.id}`,
            error_message: 'ordinary failure'
          }
        },
        200
      ),
      1000
    );
    fail(f, late.id);
    expect(f.database.query('SELECT * FROM generation_retry_reservations').all()).toHaveLength(0);
    const diagnostics = f.repository
      .eventsAfter(0)
      .find((e) => e.jobId === late.id && e.eventType === 'status.diagnostic');
    expect(diagnostics?.payload?.providerDiagnostic).toMatchObject({ observedCreditsAmount: 0 });
    const history = (await new LibraryRepository(f.database).getJobDetail(late.id))?.history;
    expect(history?.find((e) => e.eventType === 'status.diagnostic')?.authority).toBe('poyo');
  });
  test('missing acknowledgements, disabled roots, and old jobs never acquire a retry policy later', async () => {
    const f = await setup(false);
    const old = create(f);
    accept(f, old.id);
    f.settings.set('operations', {
      ...DEFAULT_OPERATIONS_SETTINGS,
      generationRetries: { enabled: true, maxRetries: 1 }
    });
    fail(f, old.id);
    const unack = create(f);
    f.repository.applyStatus(unack.id, rejection(unack.id), 1000);
    expect(f.database.query('SELECT * FROM generation_retry_reservations').all()).toHaveLength(0);
    expect(f.repository.get(old.id)?.automaticRetry).toBeNull();
  });
  test('limits snapshot future roots; omitted seed stays omitted; global disable never revives chains', async () => {
    const f = await setup(true, 1);
    const root = create(f);
    accept(f, root.id);
    fail(f, root.id);
    f.settings.set('operations', {
      ...DEFAULT_OPERATIONS_SETTINGS,
      generationRetries: { enabled: true, maxRetries: 5 }
    });
    expect(f.repository.get(root.id)?.automaticRetry?.maxRetries).toBe(1);
    expect(create(f).automaticRetry?.maxRetries).toBe(5);
    const retry = await child(f);
    expect(Object.hasOwn(retry.normalizedPayload.input, 'seed')).toBe(false);
    f.settings.set('operations', {
      ...DEFAULT_OPERATIONS_SETTINGS,
      generationRetries: { enabled: false, maxRetries: 5 }
    });
    const stopped = f.repository.get(retry.id);
    expect(stopped).toMatchObject({
      localPhase: 'complete',
      localOutcome: 'stopped-before-dispatch',
      remoteStatus: 'unknown',
      attentionCode: null
    });
    expect(safeJobDto(stopped ?? root)).toMatchObject({
      taskCharge: null,
      localSettlement: { source: 'not-submitted', credits: 0, settledAt: stopped?.settledAt }
    });
    f.settings.set('operations', {
      ...DEFAULT_OPERATIONS_SETTINGS,
      generationRetries: { enabled: true, maxRetries: 5 }
    });
    expect(f.repository.claimSubmission(retry.id, 'later', 1000)).toBeNull();
    expect(f.repository.get(root.id)?.automaticRetry?.state).toBe('stopped');
  });
  test('two database workers fence refreshes, reuse the reservation action, and recover only once', async () => {
    const f = await setup();
    const asset = managed(f);
    const root = create(f, 47, asset);
    accept(f, root.id);
    fail(f, root.id);
    f.advance();
    const db = await openDatabase(join(dirname(f.paths.media), 'studio.sqlite'));
    cleanups.push(async () => db.close());
    const other = new JobRepository(db, f.now);
    const first = f.repository.claimAutomaticRetry('first', 1000);
    expect(first).not.toBeNull();
    if (!first) return;
    expect(other.claimAutomaticRetry('second', 1000)).toBeNull();
    let resume: (value: { id: string; url: string }) => void = () => {};
    const pending = f.repository.fulfillAutomaticRetry(
      first,
      () =>
        new Promise((resolve) => {
          resume = resolve;
        })
    );
    f.advance(1001);
    const second = other.claimAutomaticRetry('second', 1000);
    if (!second) throw new Error('Missing reclaimed reservation');
    expect(second.action_id).toBe(first.action_id);
    expect(second.ordinal).toBe(first.ordinal);
    expect(second.fence).toBe(first.fence + 1);
    const winner = await other.fulfillAutomaticRetry(second, async (id) => ({
      id,
      url: 'https://source.test/fresh.png'
    }));
    resume({ id: asset, url: 'https://source.test/stale.png' });
    expect(await pending).toBeNull();
    expect(winner?.normalizedPayload.input).toMatchObject({
      image_urls: ['https://source.test/fresh.png'],
      expert_same_string: 'https://source.test/original.png'
    });
    expect(other.getByActionId(second.action_id)?.id).toBe(winner?.id);
    expect(other.list()).toHaveLength(2);
    expect(other.claimAutomaticRetry('third', 1000)).toBeNull();
  });
  test('source pins cover terminal-parent gap, refresh, and prepared child; stop wins before dispatch', async () => {
    const f = await setup();
    const asset = managed(f);
    const root = create(f, undefined, asset);
    accept(f, root.id);
    fail(f, root.id);
    const cleanup = new CleanupRepository(f.database, f.now);
    const pinned = () =>
      cleanup.listTargets('file').find((t) => t.targetId === asset)?.activeReference;
    expect(pinned()).toBe(true);
    f.advance();
    const reservation = f.repository.claimAutomaticRetry('refresh', 60000);
    if (!reservation) throw new Error('Missing reservation');
    const retry = await f.repository.fulfillAutomaticRetry(reservation, async (id) => ({
      id,
      url: 'https://source.test/fresh.png'
    }));
    if (!retry) throw new Error('Missing child');
    f.repository.releaseAutomaticRetry(reservation);
    expect(pinned()).toBe(true);
    const claim = f.repository.claimSubmission(retry.id, 'dispatch', 1000);
    if (!claim) throw new Error('Missing dispatch claim');
    f.repository.stopAutomaticRetries(root.id);
    f.repository.stopAutomaticRetries(root.id);
    expect(f.repository.markSubmissionTransmitted(retry.id, claim.token)).toBe(false);
    expect(f.repository.get(retry.id)?.localOutcome).toBe('stopped-before-dispatch');
    expect(pinned()).toBe(false);
    expect(f.repository.outstandingProjection()).toMatchObject({ actionCount: 0, credits: 0 });
    const detail = await new LibraryRepository(f.database).getJobDetail(retry.id);
    if (detail) expect(studioOutputMetadata(detail)).toEqual([]);
    expect(detail?.cost).toMatchObject({
      kind: 'not-submitted',
      source: 'not-submitted',
      credits: 0
    });
    expect(detail?.retryAttempts).toHaveLength(2);
    const persistedRetry = f.repository.get(retry.id);
    if (!persistedRetry) throw new Error('Retry missing');
    const dto = safeJobDto(persistedRetry);
    expect(isJob(dto)).toBe(true);
    expect(latestSuccessfulStudioJob({ [retry.id]: dto })).toBeNull();
    expect(batchStateForJob(dto)).toBe('failed');
    expect(statusTone('complete', 'unknown', null)).not.toBe('success');
  });
  test('stop during refresh fences child creation and releases its active source pin afterward', async () => {
    const f = await setup();
    const asset = managed(f);
    const root = create(f, undefined, asset);
    accept(f, root.id);
    fail(f, root.id);
    f.advance();
    const claim = f.repository.claimAutomaticRetry('refresh', 60000);
    if (!claim) throw new Error('Missing claim');
    let resume: (v: { id: string; url: string }) => void = () => {};
    const pending = f.repository.fulfillAutomaticRetry(
      claim,
      () =>
        new Promise((resolve) => {
          resume = resolve;
        })
    );
    f.repository.stopAutomaticRetries(root.id);
    const cleanup = new CleanupRepository(f.database, f.now);
    expect(cleanup.listTargets('file').find((t) => t.targetId === asset)?.activeReference).toBe(
      true
    );
    resume({ id: asset, url: 'https://source.test/fresh.png' });
    expect(await pending).toBeNull();
    f.repository.releaseAutomaticRetry(claim);
    expect(cleanup.listTargets('file').find((t) => t.targetId === asset)?.activeReference).toBe(
      false
    );
    expect(f.repository.list()).toHaveLength(1);
  });
  test('missing managed source blocks once without paid creation or budget reset; manual rerun stops chains', async () => {
    const f = await setup();
    const asset = managed(f);
    const root = create(f, undefined, asset);
    accept(f, root.id);
    fail(f, root.id);
    f.advance();
    const claim = f.repository.claimAutomaticRetry('refresh', 1000);
    if (!claim) throw new Error('Missing claim');
    let refreshes = 0;
    await f.repository.fulfillAutomaticRetry(claim, async () => {
      refreshes++;
      throw new Error('Missing retained source');
    });
    f.repository.releaseAutomaticRetry(claim);
    expect(f.repository.get(root.id)?.automaticRetry).toMatchObject({
      state: 'blocked',
      retriesUsed: 0
    });
    f.advance();
    expect(f.repository.claimAutomaticRetry('again', 1000)).toBeNull();
    expect(refreshes).toBe(1);
    const next = create(f);
    accept(f, next.id);
    fail(f, next.id);
    const active = await child(f);
    accept(f, active.id);
    await expect(
      f.repository.rerunAsNew(next.id, crypto.randomUUID(), async () => {
        throw new Error('unexpected refresh');
      })
    ).rejects.toMatchObject({ code: 'automatic_retry_in_flight' });
    expect(f.repository.get(next.id)?.automaticRetry?.state).toBe('stopped');
    f.repository.applyStatus(
      active.id,
      { ...rejection(active.id), errorMessage: 'ordinary failure' },
      1000
    );
    const manual = await f.repository.rerunAsNew(next.id, crypto.randomUUID(), async () => {
      throw new Error('unexpected refresh');
    });
    expect(manual.retryOfJobId).toBe(next.id);
    expect(manual.automaticRetry?.ordinal).toBe(0);
  });
  test('pending estimate transfers once; child live/reconnect tracking follows a known root', async () => {
    const f = await setup();
    const root = create(f);
    accept(f, root.id);
    fail(f, root.id);
    expect(f.repository.outstandingProjection()).toMatchObject({ actionCount: 1, credits: 5 });
    const cursor = f.repository.eventBounds().max;
    const retry = await child(f);
    expect(f.repository.outstandingProjection()).toMatchObject({ actionCount: 1, credits: 5 });
    const persistedRoot = f.repository.get(root.id);
    if (!persistedRoot) throw new Error('Root missing');
    let session: import('../../../src/lib/features/generation/studio-session').StudioSessionJobs = {
      [root.id]: safeJobDto(persistedRoot)
    };
    for (const event of f.repository.eventsAfter(cursor))
      session = applyStudioJobEvent(session, event);
    expect(session[retry.id]).toBeDefined();
    const recovered = mergeKnownStudioSnapshot(
      { [root.id]: safeJobDto(root) },
      f.repository.list().map(safeJobDto)
    );
    expect(recovered[retry.id]).toBeDefined();
    expect(
      initialJobEvents(f.repository, String(cursor))
        .chunks.map(decodeEventChunk)
        .some((e) => JSON.stringify(e.data).includes('retry.child_created'))
    ).toBe(true);
  });
  test('unknown child dispatch and no-task HTTP rejection never schedule successors', async () => {
    const f = await setup();
    const root = create(f);
    accept(f, root.id);
    fail(f, root.id);
    const retry = await child(f);
    let calls = 0;
    const coordinator = new JobCoordinator({
      repository: f.repository,
      downloader: new OutputDownloader({ repository: f.repository, paths: f.paths }),
      poyo: {
        submit: async (_payload, options) => {
          calls++;
          await options?.beforeDispatch?.();
          throw new PoyoError({
            category: 'network',
            operation: 'submit',
            technicalCode: 'network_failure',
            message: 'Unknown dispatch',
            retryable: true
          });
        },
        getStatus: async () => {
          throw new Error('No task');
        },
        getBalance: async () => ({
          email: 'test@example.test',
          creditsAmount: 100,
          fetchedAt: f.now().toISOString()
        })
      }
    });
    await coordinator.submit(retry.id);
    await coordinator.recoverOnce();
    expect(calls).toBe(1);
    expect(f.repository.get(retry.id)).toMatchObject({
      attentionCode: 'submission_unknown',
      automaticRetry: { state: 'needs_attention' }
    });
    const noTask = create(f);
    const claim = f.repository.claimSubmission(noTask.id, 'submit', 1000);
    if (!claim) throw new Error('Missing claim');
    const error = normalizePoyoError('submit', 400, {
      code: 400,
      error: {
        type: 'content_moderation_error',
        message: evidence.documentedFailedStatus.data.error_message
      }
    });
    f.repository.rejectSubmission(
      noTask.id,
      claim.token,
      error.technicalCode,
      error.providerDiagnostic
    );
    expect(f.repository.claimAutomaticRetry('retry', 1000)).toBeNull();
  });
  test('terminal acknowledgements settle once or poll boundedly and are never retry eligible', async () => {
    const f = await setup();
    const detailed = create(f);
    const claim = f.repository.claimSubmission(detailed.id, 'submit', 1000);
    if (!claim) throw new Error('Missing claim');
    f.repository.markSubmissionTransmitted(detailed.id, claim.token);
    f.repository.acknowledgeSubmission(
      detailed.id,
      claim.token,
      parseSubmitResponse(
        {
          ...evidence.documentedFailedStatus,
          data: { ...evidence.documentedFailedStatus.data, task_id: `task-${detailed.id}` }
        },
        200
      )
    );
    expect(f.repository.get(detailed.id)).toMatchObject({
      remoteStatus: 'failed',
      localPhase: 'complete',
      actualCredits: 0,
      automaticRetry: { state: 'needs_attention' }
    });
    expect(f.repository.taskCharge(detailed.id)?.settledAt).toBe(f.now().toISOString());
    const pending = create(f);
    const pendingClaim = f.repository.claimSubmission(pending.id, 'submit', 1000);
    if (!pendingClaim) throw new Error('Missing claim');
    f.repository.markSubmissionTransmitted(pending.id, pendingClaim.token);
    f.repository.acknowledgeSubmission(
      pending.id,
      pendingClaim.token,
      parseSubmitResponse(
        { data: { task_id: `task-${pending.id}`, status: 'failed', created_time: 'now' } },
        200
      )
    );
    expect(f.repository.get(pending.id)?.remoteStatus).toBe('unknown');
    for (let i = 0; i < 3; i++) {
      f.advance();
      f.repository.applyStatus(
        pending.id,
        { ...rejection(pending.id), status: 'running', statusRaw: 'running', errorMessage: null },
        1000
      );
    }
    expect(f.repository.get(pending.id)).toMatchObject({
      localPhase: 'requires_attention',
      attentionCode: 'terminal_ack_unresolved',
      nextPollAt: null
    });
    expect(f.repository.claimAutomaticRetry('retry', 1000)).toBeNull();
  });
  test('legacy settings backfill only retry defaults and strictly reject invalid retry bounds', async () => {
    const f = await setup();
    const legacy = {
      ...DEFAULT_OPERATIONS_SETTINGS,
      polling: { intervalMs: 17000, staleAfterMs: 600000 },
      logs: { ...DEFAULT_OPERATIONS_SETTINGS.logs, maxRotatedFiles: 4 }
    };
    const { generationRetries: _removed, ...old } = legacy;
    f.settings.set('operations', old);
    expect(
      f.settings.get<{ generationRetries: unknown; polling: unknown; logs: unknown }>('operations')
        ?.value
    ).toMatchObject({
      generationRetries: { enabled: false, maxRetries: 3 },
      polling: old.polling,
      logs: old.logs
    });
    expect(
      runtimeOperationsSettings({ ...old, generationRetries: { enabled: false } })
    ).toMatchObject({
      generationRetries: { enabled: false, maxRetries: 3 },
      polling: old.polling,
      logs: old.logs
    });
    expect(runtimeOperationsSettings(old)).toMatchObject({
      generationRetries: { enabled: false, maxRetries: 3 },
      polling: old.polling,
      logs: old.logs
    });
    for (const maxRetries of [0, 6, 1.5, '3', null])
      expect(() =>
        normalizeOperationsSettings({ ...old, generationRetries: { enabled: true, maxRetries } })
      ).toThrow();
    const undefinedSeed = f.repository.create({
      actionId: crypto.randomUUID(),
      workflow: 'text-to-image',
      publicModelId: 'flux-dev',
      guidedRequest: {},
      normalizedPayload: { model: 'flux-dev', input: { seed: undefined } }
    });
    expect(
      f.repository
        .eventsAfter(0)
        .find((e) => e.jobId === undefinedSeed.id && e.eventType === 'job.created')?.payload
        ?.seed_explicit
    ).toBe(false);
  });
  test('unknown raw status is canonicalized once for duplicate direct observations', async () => {
    const f = await setup();
    const job = create(f);
    accept(f, job.id);
    const status = {
      ...rejection(job.id),
      status: 'unknown' as const,
      statusRaw: 'PrivateCredentialAbCd1234_5678',
      errorMessage: null
    };
    f.repository.applyStatus(job.id, status, 1000);
    f.advance();
    f.repository.applyStatus(job.id, status, 1000);
    expect(
      f.repository
        .eventsAfter(0)
        .filter((e) => e.jobId === job.id && e.eventType === 'status.observed')
    ).toHaveLength(1);
    expect(
      JSON.stringify(initialJobEvents(f.repository, '0').chunks.map(decodeEventChunk))
    ).not.toContain('PrivateCredentialAbCd1234_5678');
  });
  test('verified rejection samples are excluded before the candidate scan limit', async () => {
    const f = await setup(false);
    const registryVersion = 'image-2026-11-13.1';
    const signature = `version=pricing-signature-v1|registry=${registryVersion}|model=flux-dev|workflow=text-to-image|unit=per-output|quantity=1`;
    const pricingHash = 'a'.repeat(64);
    const createPriced = () =>
      f.repository.create({
        actionId: crypto.randomUUID(),
        entryKey: 'flux-dev:text-to-image',
        workflow: 'text-to-image',
        publicModelId: 'flux-dev',
        guidedRequest: { prompt: 'test' },
        normalizedPayload: { model: 'flux-dev', input: { prompt: 'test' } },
        estimatedCredits: 5,
        estimateEnvelope: {
          signatureVersion: PRICING_SIGNATURE_VERSION,
          signature,
          registryVersion,
          pricingHash,
          basis: { unit: 'per-output', creditsPerUnit: 5, units: 1 },
          provenance: 'published',
          sourceVerifiedAt: '2026-07-15T00:00:00.000Z',
          credits: 5
        }
      });
    const valid = createPriced();
    accept(f, valid.id);
    f.repository.applyStatus(
      valid.id,
      { ...rejection(valid.id), creditsAmount: 7, errorMessage: 'ordinary failed task' },
      1000
    );
    for (let i = 0; i < 60; i++) {
      f.advance();
      const rejected = createPriced();
      accept(f, rejected.id);
      fail(f, rejected.id);
    }
    const samples = f.repository.observedChargeSamples({
      signature,
      signatureVersion: PRICING_SIGNATURE_VERSION,
      registryVersion,
      pricingHash
    });
    expect(samples).toHaveLength(1);
    expect(samples[0]?.charge.credits).toBe(7);
    expect(f.repository.taskCharge(valid.id)?.credits).toBe(7);
    expect(f.repository.list().filter((j) => j.actualCredits === 0)).toHaveLength(60);
  });
  test('worker restart resumes reserved and prepared attempts through normal dispatch exactly once', async () => {
    const f = await setup(true, 1);
    const root = create(f);
    let submits = 0;
    let balances = 0;
    const gateway = {
      submit: async (
        _request: unknown,
        options?: import('../../../src/lib/server/poyo/types').PoyoRequestOptions
      ) => {
        await options?.beforeDispatch?.();
        submits++;
        return {
          taskId: `worker-task-${submits}`,
          status: 'running' as const,
          statusRaw: 'running',
          createdTime: 'now'
        };
      },
      getStatus: async (taskId: string) =>
        parseStatusResponse(
          {
            ...evidence.documentedFailedStatus,
            data: { ...evidence.documentedFailedStatus.data, task_id: taskId }
          },
          200
        ),
      getBalance: async () => {
        balances++;
        return { email: 'test@example.test', creditsAmount: 100, fetchedAt: f.now().toISOString() };
      }
    };
    const make = () =>
      new JobCoordinator({
        repository: new JobRepository(f.database, f.now),
        poyo: gateway,
        now: f.now,
        automaticDownloads: false,
        downloader: new OutputDownloader({ repository: f.repository, paths: f.paths })
      });
    await make().recoverOnce();
    expect(submits).toBe(1);
    f.advance();
    await make().recoverOnce();
    expect(f.repository.get(root.id)?.automaticRetry?.nextRetryAt).not.toBeNull();
    f.advance();
    const reservation = f.repository.claimAutomaticRetry('prepare-only', 1000);
    if (!reservation) throw new Error('Missing reservation');
    const prepared = await f.repository.fulfillAutomaticRetry(reservation, async () => {
      throw new Error('Unexpected upload');
    });
    if (!prepared) throw new Error('Missing prepared child');
    expect(submits).toBe(1);
    await Promise.all([make().recoverOnce(), make().recoverOnce()]);
    expect(submits).toBe(2);
    f.advance();
    await make().recoverOnce();
    expect(f.repository.get(prepared.id)?.automaticRetry?.state).toBe('exhausted');
    await make().recoverOnce();
    expect(submits).toBe(2);
    expect(balances).toBe(4);
  });
  test('stale poll callback cannot settle or reserve after another worker owns the lease', async () => {
    const f = await setup();
    const root = create(f);
    accept(f, root.id);
    let resume: (value: ReturnType<typeof rejection>) => void = () => {};
    const coordinator = new JobCoordinator({
      repository: f.repository,
      now: f.now,
      workLeaseMs: 1000,
      automaticDownloads: false,
      downloader: new OutputDownloader({ repository: f.repository, paths: f.paths }),
      poyo: {
        submit: async () => {
          throw new Error('Unexpected submit');
        },
        getStatus: () =>
          new Promise((resolve) => {
            resume = resolve;
          }),
        getBalance: async () => {
          throw new Error('Unexpected balance');
        }
      }
    });
    const pending = coordinator.poll(root.id);
    f.advance(1001);
    const second = new JobRepository(f.database, f.now);
    expect(second.claimWork('poll', root.id, 'replacement', 1000)).not.toBeNull();
    resume(
      parseStatusResponse(
        {
          code: 200,
          data: {
            ...evidence.documentedFailedStatus.data,
            task_id: `task-${root.id}`,
            status: 'running',
            error_message: null,
            files: [{ file_url: 'https://media.test/stale.png', file_type: 'image' }]
          }
        },
        200
      )
    );
    await pending;
    expect(f.repository.get(root.id)?.remoteStatus).toBe('running');
    expect(f.repository.get(root.id)?.outputObserved).toBe(false);
    expect(f.repository.claimAutomaticRetry('retry', 1000)).toBeNull();
  });
  test('stop after dispatch preserves the active task and prevents its eligible successor', async () => {
    const f = await setup();
    const root = create(f);
    accept(f, root.id);
    fail(f, root.id);
    const retry = await child(f);
    accept(f, retry.id);
    f.repository.stopAutomaticRetries(root.id);
    expect(f.repository.get(retry.id)).toMatchObject({
      remoteStatus: 'running',
      localPhase: 'monitoring'
    });
    fail(f, retry.id);
    f.advance();
    expect(f.repository.claimAutomaticRetry('retry', 1000)).toBeNull();
    expect(f.repository.taskCharge(retry.id)?.credits).toBe(0);
  });
  test('missing explicit files and incompatible registry never create a successor', async () => {
    const f = await setup();
    const root = create(f);
    accept(f, root.id);
    const { files: _omitted, ...data } = evidence.documentedFailedStatus.data;
    f.repository.applyStatus(
      root.id,
      parseStatusResponse({ data: { ...data, task_id: `task-${root.id}` } }, 200),
      1000
    );
    expect(f.repository.claimAutomaticRetry('retry', 1000)).toBeNull();
    const changed = create(f);
    accept(f, changed.id);
    fail(f, changed.id);
    f.advance();
    const claim = f.repository.claimAutomaticRetry('registry', 1000);
    if (!claim) throw new Error('Missing claim');
    f.database
      .query(
        "UPDATE registry_entries SET status='historical' WHERE entry_key='flux-dev:text-to-image'"
      )
      .run();
    expect(
      await f.repository.fulfillAutomaticRetry(claim, async () => {
        throw new Error('Unexpected refresh');
      })
    ).toBeNull();
    expect(f.repository.get(changed.id)?.automaticRetry?.state).toBe('blocked');
  });
  test('successful attempt settles charge once, verifies artifacts, and marks the chain succeeded', async () => {
    const f = await setup();
    const root = create(f);
    accept(f, root.id);
    fail(f, root.id);
    const retry = await child(f);
    accept(f, retry.id);
    const status = parseStatusResponse(
      {
        data: {
          task_id: `task-${retry.id}`,
          status: 'finished',
          credits_amount: 7,
          files: [{ file_url: 'https://media.test/output.png', file_type: 'image' }],
          created_time: 'now'
        }
      },
      200
    );
    f.repository.applyStatus(retry.id, status, 1000);
    const settledAt = f.repository.taskCharge(retry.id)?.settledAt;
    expect(f.repository.get(retry.id)?.automaticRetry?.state).toBe('succeeded');
    const output = f.repository.outputs(retry.id)[0];
    if (!output) throw new Error('Missing output');
    const attempt = f.repository.startDownload(output.id);
    f.repository.verifyDownload(output.id, attempt, {
      path: join(f.paths.media, 'output.png'),
      contentType: 'image/png',
      size: 8,
      checksum: 'checksum',
      signature: '89504e47'
    });
    f.repository.finishIfDownloaded(retry.id);
    expect(f.repository.get(retry.id)).toMatchObject({
      localPhase: 'complete',
      remoteStatus: 'finished',
      automaticRetry: { state: 'succeeded', chargedCredits: 7, unknownCharges: 0 }
    });
    f.advance();
    f.repository.applyStatus(retry.id, status, 1000);
    expect(f.repository.taskCharge(retry.id)?.settledAt).toBe(settledAt);
    expect((await new LibraryRepository(f.database).getJobDetail(retry.id))?.cost).toMatchObject({
      kind: 'charge',
      credits: 7,
      settledAt
    });
    expect(safeJobDto(f.repository.get(retry.id) ?? retry).taskCharge?.settledAt).toBe(settledAt);
  });
  test('only the original documented data.error_message proves a rejection; diagnostic fallbacks never do', async () => {
    const f = await setup();
    const message = evidence.documentedFailedStatus.data.error_message;
    for (const location of [
      'detail',
      'root-error',
      'data-error',
      'missing',
      'null',
      'unwrapped',
      'string-code',
      'documented',
      'other-field-with-data-error',
      'documented-conflicting-diagnostic'
    ]) {
      const job = create(f);
      accept(f, job.id);
      const { error_message: _removed, ...fields } = evidence.documentedFailedStatus.data;
      const data: Record<string, unknown> = { ...fields, task_id: `task-${job.id}` };
      const payload: Record<string, unknown> = { code: 200, data };
      if (location === 'detail') payload.detail = message;
      if (location === 'root-error') payload.error = { message };
      if (location === 'data-error') data.error = { message };
      if (location === 'other-field-with-data-error') {
        data.error_message = 'Other failure';
        data.error = { message };
      }
      if (location === 'null') {
        data.error_message = null;
        payload.detail = message;
      }
      if (location === 'unwrapped') {
        delete payload.data;
        Object.assign(payload, data, { error_message: message });
      }
      if (location === 'string-code') {
        payload.code = '200';
        data.error_message = message;
      }
      const eligible = location.startsWith('documented');
      if (eligible) data.error_message = message;
      if (location === 'documented-conflicting-diagnostic')
        payload.error = { message: 'unrelated diagnostic' };
      const parsed = parseStatusResponse(payload, 200);
      expect(parsed.errorMessage).toBe(eligible ? message : null);
      if (['detail', 'root-error', 'data-error', 'null'].includes(location))
        expect(parsed.providerDiagnostic?.documentedMessage).toBe(message);
      f.repository.applyStatus(job.id, parsed, 1000);
      const reservation = f.database
        .query<{ parent_id: string }, [string]>(
          'SELECT parent_id FROM generation_retry_reservations WHERE parent_id=?'
        )
        .get(job.id);
      expect(Boolean(reservation)).toBe(eligible);
    }
  });
  test('a previously reported partial output permanently excludes the attempt, including after reopening the database', async () => {
    const f = await setup();
    const job = create(f);
    accept(f, job.id);
    const running = (files: unknown[]) =>
      parseStatusResponse(
        {
          code: 200,
          data: {
            ...evidence.documentedFailedStatus.data,
            task_id: `task-${job.id}`,
            status: 'running',
            error_message: null,
            files
          }
        },
        200
      );
    f.repository.applyStatus(
      job.id,
      running([{ file_url: 'https://media.test/private-output-canary.png', file_type: 'image' }]),
      1000
    );
    expect(f.repository.get(job.id)?.outputObserved).toBe(true);
    expect(f.repository.outputs(job.id)).toHaveLength(0);
    f.repository.applyStatus(job.id, running([]), 1000);
    const db = await openDatabase(join(dirname(f.paths.media), 'studio.sqlite'));
    cleanups.push(async () => db.close());
    const restarted = new JobRepository(db, f.now);
    expect(restarted.get(job.id)?.outputObserved).toBe(true);
    fail(f, job.id, restarted);
    expect(restarted.get(job.id)).toMatchObject({
      outputObserved: true,
      remoteStatus: 'failed',
      automaticRetry: { state: 'needs_attention' }
    });
    f.advance();
    expect(restarted.claimAutomaticRetry('after-restart', 1000)).toBeNull();
    const terminal = restarted
      .eventsAfter(0)
      .find(
        (event) =>
          event.jobId === job.id &&
          event.eventType === 'status.observed' &&
          event.remoteStatus === 'failed'
      );
    expect(terminal?.payload).toMatchObject({
      outputObserved: true,
      retryEligibleRejection: false
    });
    expect(JSON.stringify(restarted.eventsAfter(0))).not.toContain('private-output-canary');
    const control = create(f);
    accept(f, control.id);
    f.repository.applyStatus(
      control.id,
      parseStatusResponse(
        {
          code: 200,
          data: {
            ...evidence.documentedFailedStatus.data,
            task_id: `task-${control.id}`,
            status: 'running',
            error_message: null
          }
        },
        200
      ),
      1000
    );
    fail(f, control.id);
    f.advance();
    expect(restarted.claimAutomaticRetry('no-output-control', 1000)?.parent_id).toBe(control.id);
  });
  test('mismatched and ignored output observations cannot poison the durable marker', async () => {
    const f = await setup();
    const job = create(f);
    accept(f, job.id);
    const withOutput = parseStatusResponse(
      {
        code: 200,
        data: {
          ...evidence.documentedFailedStatus.data,
          task_id: 'another-task',
          status: 'running',
          error_message: null,
          files: [{ file_url: 'https://media.test/output.png', file_type: 'image' }]
        }
      },
      200
    );
    f.repository.applyStatus(job.id, withOutput, 1000);
    expect(f.repository.get(job.id)?.outputObserved).toBe(false);
    fail(f, job.id);
    expect(
      f.database.query('SELECT * FROM generation_retry_reservations WHERE parent_id=?').get(job.id)
    ).not.toBeNull();
    const terminal = create(f);
    accept(f, terminal.id);
    f.repository.applyStatus(terminal.id, { ...rejection(terminal.id), errorMessage: null }, 1000);
    f.repository.applyStatus(terminal.id, { ...withOutput, taskId: `task-${terminal.id}` }, 1000);
    expect(f.repository.get(terminal.id)?.outputObserved).toBe(false);
    fail(f, terminal.id);
    expect(
      f.database
        .query('SELECT * FROM generation_retry_reservations WHERE parent_id=?')
        .get(terminal.id)
    ).toBeNull();
  });
  test('stop, global disable and manual rerun preserve each terminal chain outcome and reason', async () => {
    const f = await setup();
    for (const [state, reason] of [
      ['succeeded', null],
      ['exhausted', 'retry-budget-exhausted'],
      ['blocked', 'source-or-registry-unavailable'],
      ['needs_attention', 'ineligible-failure'],
      ['needs_attention', 'submission-unknown']
    ] as const) {
      const root = create(f);
      accept(f, root.id);
      f.repository.applyStatus(root.id, { ...rejection(root.id), errorMessage: null }, 1000);
      f.database
        .query('UPDATE generation_retry_roots SET state=?,reason=? WHERE root_id=?')
        .run(state, reason, root.id);
      const expected = { state, reason };
      f.repository.stopAutomaticRetries(root.id);
      f.repository.stopAutomaticRetries(root.id);
      expect(f.repository.get(root.id)?.automaticRetry).toMatchObject(expected);
      f.repository.stopAllAutomaticRetries();
      expect(f.repository.get(root.id)?.automaticRetry).toMatchObject(expected);
      await f.repository.rerunAsNew(root.id, crypto.randomUUID(), async () => {
        throw new Error('Unexpected refresh');
      });
      expect(f.repository.get(root.id)?.automaticRetry).toMatchObject(expected);
      expect(
        f.repository
          .eventsAfter(0)
          .filter((event) => event.jobId === root.id && event.eventType === 'retry.stopped')
      ).toHaveLength(0);
    }
  });
  test('terminal outcome preservation still defensively closes pending reservations and unsent children', async () => {
    const f = await setup();
    const root = create(f);
    accept(f, root.id);
    fail(f, root.id);
    const retry = await child(f);
    f.database
      .query(
        "UPDATE generation_retry_roots SET state='exhausted',reason='retry-budget-exhausted' WHERE root_id=?"
      )
      .run(root.id);
    f.repository.stopAutomaticRetries(root.id);
    expect(f.repository.get(root.id)?.automaticRetry).toMatchObject({
      state: 'exhausted',
      reason: 'retry-budget-exhausted'
    });
    expect(f.repository.get(retry.id)?.localOutcome).toBe('stopped-before-dispatch');
    const pending = create(f);
    accept(f, pending.id);
    fail(f, pending.id);
    f.database
      .query(
        "UPDATE generation_retry_roots SET state='needs_attention',reason='ineligible-failure' WHERE root_id=?"
      )
      .run(pending.id);
    f.repository.stopAllAutomaticRetries();
    expect(
      f.database
        .query<{ state: string }, [string]>(
          'SELECT state FROM generation_retry_reservations WHERE parent_id=?'
        )
        .get(pending.id)?.state
    ).toBe('stopped');
    expect(f.repository.get(pending.id)?.automaticRetry).toMatchObject({
      state: 'needs_attention',
      reason: 'ineligible-failure'
    });
    expect(
      f.repository
        .eventsAfter(0)
        .some((event) => event.jobId === pending.id && event.eventType === 'retry.pending_stopped')
    ).toBe(true);
  });
  test('remote completion succeeds with automatic downloads off and survives local download failure and repair', async () => {
    const f = await setup();
    const root = create(f);
    accept(f, root.id);
    const finished = parseStatusResponse(
      {
        code: 200,
        data: {
          task_id: `task-${root.id}`,
          status: 'finished',
          credits_amount: 7,
          files: [{ file_url: 'https://media.test/repair.png', file_type: 'image' }],
          created_time: 'now'
        }
      },
      200
    );
    const coordinator = new JobCoordinator({
      repository: f.repository,
      now: f.now,
      automaticDownloads: false,
      downloader: new OutputDownloader({ repository: f.repository, paths: f.paths }),
      poyo: {
        submit: async () => {
          throw new Error('Unexpected submit');
        },
        getStatus: async () => finished,
        getBalance: async () => ({
          email: 'test@example.test',
          creditsAmount: 93,
          fetchedAt: f.now().toISOString()
        })
      }
    });
    await coordinator.poll(root.id);
    expect(f.repository.get(root.id)).toMatchObject({
      localPhase: 'downloading',
      automaticRetry: { state: 'succeeded', reason: null }
    });
    expect(
      latestSuccessfulStudioJob({ [root.id]: safeJobDto(f.repository.get(root.id) ?? root) })
    ).toBeNull();
    const output = f.repository.outputs(root.id)[0];
    if (!output) throw new Error('Output missing');
    const attempt = f.repository.startDownload(output.id);
    f.repository.failDownload(output.id, attempt, { code: 'download_failed' });
    expect(f.repository.get(root.id)).toMatchObject({
      localPhase: 'requires_attention',
      automaticRetry: { state: 'succeeded', reason: null }
    });
    const detail = await new LibraryRepository(f.database).getJobDetail(root.id);
    if (!detail) throw new Error('Detail missing');
    expect(studioOutputMetadata(detail)).toMatchObject([
      { outputId: output.id, downloadState: 'failed', mediaUrl: null, localAvailable: false }
    ]);
    const closed = {
      ...detail,
      remoteStatus: 'unknown',
      localPhase: 'complete',
      localOutcome: 'stopped-before-dispatch' as const
    };
    expect(studioOutputMetadata(closed)).toEqual([]);
    f.repository.stopAutomaticRetries(root.id);
    f.settings.set('operations', {
      ...DEFAULT_OPERATIONS_SETTINGS,
      generationRetries: { enabled: false, maxRetries: 3 }
    });
    f.settings.set('operations', {
      ...DEFAULT_OPERATIONS_SETTINGS,
      generationRetries: { enabled: true, maxRetries: 3 }
    });
    expect(f.repository.get(root.id)?.automaticRetry).toMatchObject({
      state: 'succeeded',
      reason: null
    });
    const retried = f.repository.startDownload(output.id);
    f.repository.verifyDownload(output.id, retried, {
      path: join(f.paths.media, 'repair.png'),
      contentType: 'image/png',
      size: 8,
      checksum: 'checksum',
      signature: '89504e47'
    });
    f.repository.finishIfDownloaded(root.id);
    expect(f.repository.get(root.id)).toMatchObject({
      localPhase: 'complete',
      remoteStatus: 'finished',
      automaticRetry: { state: 'succeeded' }
    });
    expect(
      f.repository
        .eventsAfter(0)
        .filter((event) => event.jobId === root.id && event.eventType === 'retry.succeeded')
    ).toHaveLength(1);
  });
  test('manual source failures retain actionable 409 errors while automatic refresh remains blocked', async () => {
    const f = await setup();
    const asset = managed(f);
    for (const failure of ['unmanaged', 'missing', 'binding'] as const) {
      const root = create(f, undefined, asset);
      accept(f, root.id);
      if (failure === 'unmanaged')
        f.database
          .query('UPDATE job_inputs SET managed_source_id=NULL WHERE job_id=?')
          .run(root.id);
      if (failure === 'binding')
        f.database.query("UPDATE job_inputs SET role='unrecognized' WHERE job_id=?").run(root.id);
      f.repository.applyStatus(root.id, { ...rejection(root.id), errorMessage: null }, 1000);
      try {
        await f.repository.rerunAsNew(root.id, crypto.randomUUID(), async () => {
          throw new Error('Missing file');
        });
        throw new Error('Expected source review error');
      } catch (error) {
        const response = jobHttpError(error);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          error: {
            code: 'rerun_source_requires_review',
            message: expect.stringContaining('Studio')
          }
        });
      }
    }
    const automatic = create(f, undefined, asset);
    accept(f, automatic.id);
    fail(f, automatic.id);
    f.advance();
    const claim = f.repository.claimAutomaticRetry('refresh', 1000);
    if (!claim) throw new Error('Reservation missing');
    await f.repository.fulfillAutomaticRetry(claim, async () => {
      throw new Error('Missing file');
    });
    expect(f.repository.get(automatic.id)?.automaticRetry).toMatchObject({
      state: 'blocked',
      reason: 'source-or-registry-unavailable'
    });
  });
});
