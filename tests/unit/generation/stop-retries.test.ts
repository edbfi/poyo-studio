import { describe, expect, test } from 'bun:test';
import type { StudioJobDto } from '../../../src/lib/features/generation/contracts';
import { requestStopRetries } from '../../../src/lib/features/generation/stop-retries';

function job(state: 'running' | 'stopped'): StudioJobDto {
  return {
    id: 'job',
    workflow: 'text-to-image',
    publicModelId: 'model',
    localPhase: 'monitoring',
    remoteStatus: 'running',
    failureDomain: 'none',
    attentionCode: null,
    poyoTaskId: 'task',
    progress: 0,
    estimatedCredits: 1,
    actualCredits: null,
    lastPolledAt: null,
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedAt: '2026-07-18T10:00:01.000Z',
    completedAt: null,
    automaticRetry: {
      rootId: 'job',
      parentId: null,
      ordinal: 0,
      maxRetries: 3,
      state,
      retriesUsed: 0,
      nextRetryAt: null,
      reason: null,
      chargedCredits: 0,
      unknownCharges: 1
    }
  };
}
describe('confirmed stop requests', () => {
  test('HTTP, network, JSON and unconfirmed responses leave local state untouched', async () => {
    const sends: Array<() => Promise<Response>> = [
      async () => Response.json({ error: { message: 'Rejected' } }, { status: 409 }),
      async () => {
        throw new Error('Network unavailable');
      },
      async () => new Response('{bad'),
      async () => Response.json({}),
      async () => Response.json({ job: job('running') })
    ];
    for (const send of sends) {
      const original = job('running');
      let current = original;
      try {
        current = await requestStopRetries('job', send);
      } catch {
        /* UI renders the request failure. */
      }
      expect(current).toBe(original);
      expect(current.automaticRetry?.state).toBe('running');
      await expect(requestStopRetries('job', send)).rejects.toThrow();
    }
  });
  test('accepts only a valid server confirmation after posting the stop', async () => {
    const confirmed = job('stopped');
    const result = await requestStopRetries('job', async (path, init) => {
      expect(path).toBe('/api/jobs/job/stop-retries');
      expect(init?.method).toBe('POST');
      return Response.json({ job: confirmed });
    });
    expect(result).toEqual(confirmed);
  });
});
