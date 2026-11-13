import { describe, expect, test } from 'bun:test';
import type { StudioJobDto } from '../../../src/lib/features/generation/contracts';
import {
  applyStudioJobEvent,
  compareStudioJobRecency,
  latestSuccessfulStudioJob,
  mergeKnownStudioSnapshot,
  nextStudioResultCandidate,
  pruneTerminalStudioJobs,
  restoreStudioSessionSelection,
  upsertStudioSessionJob
} from '../../../src/lib/features/generation/studio-session';

function job(overrides: Partial<StudioJobDto> = {}): StudioJobDto {
  return {
    id: 'job-a',
    workflow: 'text-to-image',
    publicModelId: 'provider/model',
    localPhase: 'monitoring',
    remoteStatus: 'running',
    failureDomain: 'none',
    attentionCode: null,
    poyoTaskId: 'task-a',
    progress: 20,
    estimatedCredits: null,
    actualCredits: null,
    lastPolledAt: null,
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedAt: '2026-07-18T10:00:01.000Z',
    completedAt: null,
    ...overrides
  };
}

describe('studio session jobs', () => {
  test('merges POST, known snapshots and SSE without admitting unrelated history', () => {
    let jobs = upsertStudioSessionJob({}, job());
    jobs = mergeKnownStudioSnapshot(jobs, [
      job({ progress: 40, updatedAt: '2026-07-18T10:00:02.000Z' }),
      job({ id: 'historical-job', updatedAt: '2026-07-18T10:00:03.000Z' })
    ]);
    jobs = applyStudioJobEvent(jobs, {
      jobId: 'job-a',
      localPhase: 'complete',
      remoteStatus: 'finished',
      failureDomain: 'none',
      progress: 100,
      observedAt: '2026-07-18T10:00:04.000Z'
    });
    expect(Object.keys(jobs)).toEqual(['job-a']);
    expect(jobs['job-a']).toMatchObject({ localPhase: 'complete', progress: 100 });
    expect(jobs['job-a']?.completedAt).toBe('2026-07-18T10:00:04.000Z');
  });

  test('rejects stale updates and terminal regressions', () => {
    const complete = job({
      localPhase: 'complete',
      remoteStatus: 'finished',
      progress: 100,
      updatedAt: '2026-07-18T10:00:04.000Z',
      completedAt: '2026-07-18T10:00:04.000Z'
    });
    const jobs = upsertStudioSessionJob(
      { 'job-a': complete },
      job({ progress: 10, updatedAt: '2026-07-18T10:00:03.000Z' })
    );
    const regressed = applyStudioJobEvent(jobs, {
      jobId: 'job-a',
      localPhase: 'monitoring',
      remoteStatus: 'running',
      failureDomain: 'none',
      progress: 80,
      observedAt: '2026-07-18T10:00:05.000Z'
    });
    expect(regressed['job-a']).toEqual(complete);
  });

  test('distinguishes explicit attention clears from legacy event omission', () => {
    const blocked = job({
      localPhase: 'requires_attention',
      attentionCode: 'ip_guard_blocked',
      ipGuardReason: 'unavailable'
    });

    const afterLegacyEvent = applyStudioJobEvent(
      { 'job-a': blocked },
      {
        jobId: 'job-a',
        localPhase: 'monitoring',
        remoteStatus: 'running',
        failureDomain: 'none',
        progress: 40,
        observedAt: '2026-07-18T10:00:02.000Z'
      }
    );
    expect(afterLegacyEvent['job-a']).toMatchObject({
      attentionCode: 'ip_guard_blocked',
      ipGuardReason: 'unavailable'
    });

    const afterExplicitClear = applyStudioJobEvent(afterLegacyEvent, {
      jobId: 'job-a',
      localPhase: 'monitoring',
      remoteStatus: 'running',
      failureDomain: 'none',
      attentionCode: null,
      ipGuardReason: null,
      progress: 60,
      observedAt: '2026-07-18T10:00:03.000Z'
    });
    expect(afterExplicitClear['job-a']).toMatchObject({
      attentionCode: null,
      ipGuardReason: null
    });

    const afterExplicitSet = applyStudioJobEvent(afterExplicitClear, {
      jobId: 'job-a',
      localPhase: 'requires_attention',
      remoteStatus: 'running',
      failureDomain: 'submission',
      attentionCode: 'submission_unknown',
      ipGuardReason: null,
      progress: 60,
      observedAt: '2026-07-18T10:00:04.000Z'
    });
    expect(afterExplicitSet['job-a']).toMatchObject({
      attentionCode: 'submission_unknown',
      ipGuardReason: null
    });
  });

  test('chooses the latest successful completion deterministically', () => {
    const jobs = {
      a: job({
        id: 'a',
        localPhase: 'complete',
        remoteStatus: 'finished',
        completedAt: null,
        updatedAt: '2026-07-18T10:00:03.000Z'
      }),
      b: job({
        id: 'b',
        localPhase: 'complete',
        remoteStatus: 'finished',
        completedAt: '2026-07-18T10:00:04.000Z',
        updatedAt: '2026-07-18T10:00:05.000Z'
      }),
      c: job({
        id: 'c',
        localPhase: 'complete',
        remoteStatus: 'failed',
        completedAt: '2026-07-18T10:00:06.000Z',
        updatedAt: '2026-07-18T10:00:06.000Z'
      }),
      d: job({
        id: 'd',
        localPhase: 'complete',
        remoteStatus: 'finished',
        completedAt: '2026-07-18T10:00:04.000Z',
        updatedAt: '2026-07-18T10:00:04.000Z'
      })
    };
    expect(latestSuccessfulStudioJob(jobs)?.id).toBe('d');
  });

  test('falls back after a newer empty result without letting an older result regress the preview', () => {
    const older = job({
      id: 'older',
      localPhase: 'complete',
      remoteStatus: 'finished',
      completedAt: '2026-07-18T10:00:03.000Z',
      updatedAt: '2026-07-18T10:00:03.000Z'
    });
    const newer = job({
      id: 'newer',
      localPhase: 'complete',
      remoteStatus: 'finished',
      completedAt: '2026-07-18T10:00:04.000Z',
      updatedAt: '2026-07-18T10:00:04.000Z'
    });
    const jobs = { older, newer };

    expect(nextStudioResultCandidate(jobs, {})?.id).toBe('newer');
    expect(nextStudioResultCandidate(jobs, { newer: 'loading' })).toBeNull();
    expect(nextStudioResultCandidate(jobs, { newer: 'empty' })?.id).toBe('older');
    expect(compareStudioJobRecency(older, newer)).toBeLessThan(0);
  });
  test('dismiss/reset pruning survives persistence and reload without cancelling active paid work', () => {
    const completed = job({ id: 'completed', localPhase: 'complete', remoteStatus: 'finished' });
    const failed = job({ id: 'failed', localPhase: 'complete', remoteStatus: 'failed' });
    const active = job({ id: 'active' });
    const chain = {
      rootId: 'retry-root',
      parentId: null,
      ordinal: 0,
      maxRetries: 3,
      state: 'running' as const,
      retriesUsed: 0,
      nextRetryAt: '2026-07-18T10:00:05.000Z',
      reason: null,
      chargedCredits: 0,
      unknownCharges: 0
    };
    const anchor = job({
      id: 'retry-root',
      localPhase: 'complete',
      remoteStatus: 'failed',
      automaticRetry: chain
    });
    const pruned = pruneTerminalStudioJobs({ completed, failed, active, anchor });
    expect(Object.keys(pruned)).toEqual(['active', 'anchor']);
    expect(pruned.active).toBe(active);
    expect(pruned.anchor).toBe(anchor);
    const reloaded = restoreStudioSessionSelection(JSON.parse(JSON.stringify(pruned)), false, null);
    expect(nextStudioResultCandidate(reloaded.jobs, {})).toBeNull();
    expect(reloaded.activeJob?.id).toBe('active');
    const updated = mergeKnownStudioSnapshot(reloaded.jobs, [
      completed,
      failed,
      job({
        id: 'active',
        localPhase: 'complete',
        remoteStatus: 'finished',
        updatedAt: '2026-07-18T10:00:02.000Z'
      })
    ]);
    expect(updated.completed).toBeUndefined();
    expect(updated.failed).toBeUndefined();
    expect(nextStudioResultCandidate(updated, {})?.id).toBe('active');
    expect(restoreStudioSessionSelection({ anchor }, false, null).activeJob).toBeNull();
  });
  test('preset/from-job restoration keeps tracking without selecting or auto-opening historical results', () => {
    const active = job({ id: 'old-active' });
    const historical = job({
      id: 'old-completed',
      localPhase: 'complete',
      remoteStatus: 'finished'
    });
    const selected = job({ id: 'explicit-selection' });
    const restored = restoreStudioSessionSelection({ active, historical }, true, selected);
    expect(restored.activeJob).toBe(selected);
    expect(restored.jobs.historical).toBeUndefined();
    const snapshot = mergeKnownStudioSnapshot(restored.jobs, [
      job({
        id: 'old-active',
        localPhase: 'complete',
        remoteStatus: 'finished',
        updatedAt: '2026-07-18T10:00:03.000Z'
      })
    ]);
    expect(nextStudioResultCandidate(snapshot, {}, restored.mutedRoots)).toBeNull();
    const newRun = job({ id: 'new-run', localPhase: 'complete', remoteStatus: 'finished' });
    expect(
      nextStudioResultCandidate({ ...snapshot, [newRun.id]: newRun }, {}, restored.mutedRoots)?.id
    ).toBe('new-run');
  });
});
