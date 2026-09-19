import { describe, expect, test } from 'bun:test';
import {
  createDownloadRequestReconciler,
  createDownloadRequestSync,
  type DownloadRequestUpdate,
  latestDownloadRequestAt,
  mergeDownloadRequest
} from '../../../src/lib/features/library/download-request-sync';

class FakeChannel {
  listeners = new Set<(event: MessageEvent<unknown>) => void>();
  peer: FakeChannel | null = null;
  closed = false;
  postError: Error | null = null;

  postMessage(message: unknown): void {
    if (this.postError) throw this.postError;
    this.peer?.dispatch(message);
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  dispatch(data: unknown): void {
    for (const listener of this.listeners) listener({ data } as MessageEvent<unknown>);
  }
}

function merge(target: Map<string, string>, update: DownloadRequestUpdate): void {
  const merged = mergeDownloadRequest(target, update);
  if (!merged) return;
  target.clear();
  for (const [outputId, requestedAt] of merged) target.set(outputId, requestedAt);
}

describe('download request cross-tab sync', () => {
  test('DOWNLOAD-SYNC-01 merges close updates for different outputs in both tabs', () => {
    const firstChannel = new FakeChannel();
    const secondChannel = new FakeChannel();
    firstChannel.peer = secondChannel;
    secondChannel.peer = firstChannel;
    const firstState = new Map<string, string>();
    const secondState = new Map<string, string>();
    const first = createDownloadRequestSync({
      onupdate: (update) => merge(firstState, update),
      createChannel: () => firstChannel
    });
    const second = createDownloadRequestSync({
      onupdate: (update) => merge(secondState, update),
      createChannel: () => secondChannel
    });

    first.publish({ outputId: 'output-a', requestedAt: '2026-08-01T10:00:00.000Z' });
    second.publish({ outputId: 'output-b', requestedAt: '2026-08-01T10:00:00.001Z' });

    expect(Object.fromEntries(firstState)).toEqual({
      'output-a': '2026-08-01T10:00:00.000Z',
      'output-b': '2026-08-01T10:00:00.001Z'
    });
    expect(Object.fromEntries(secondState)).toEqual(Object.fromEntries(firstState));
    first.dispose();
    second.dispose();
    expect(firstChannel.closed).toBe(true);
    expect(secondChannel.closed).toBe(true);
  });

  test('DOWNLOAD-SYNC-02 ignores malformed messages and does not regress a newer mark', () => {
    const channel = new FakeChannel();
    const state = new Map<string, string>();
    const sync = createDownloadRequestSync({
      onupdate: (update) => merge(state, update),
      createChannel: () => channel
    });

    sync.publish({ outputId: 'output-a', requestedAt: '2026-08-01T10:00:01.001Z' });
    channel.dispatch({ version: 1, outputId: 'output-a', requestedAt: '2026-08-01T10:00:01Z' });
    channel.dispatch({ version: 1, outputId: 'output-b', requestedAt: 'not-a-date' });

    expect(Object.fromEntries(state)).toEqual({
      'output-a': '2026-08-01T10:00:01.001Z'
    });
    sync.dispose();
  });

  test('DOWNLOAD-SYNC-03 remains usable when cross-tab channels are unavailable', () => {
    const state = new Map<string, string>();
    const sync = createDownloadRequestSync({
      onupdate: (update) => merge(state, update),
      createChannel: () => {
        throw new Error('BroadcastChannel is unavailable');
      }
    });

    sync.publish({ outputId: 'output-a', requestedAt: '2026-08-01T10:00:00.000Z' });

    expect(Object.fromEntries(state)).toEqual({
      'output-a': '2026-08-01T10:00:00.000Z'
    });
    expect(() => sync.dispose()).not.toThrow();
  });

  test('DOWNLOAD-SYNC-04 selects the newest local, synchronized, or persisted request', () => {
    expect(
      latestDownloadRequestAt(
        '2026-08-01T10:00:00Z',
        '2026-08-01T10:00:00.003Z',
        '2026-08-01T10:00:00.002Z'
      )
    ).toBe('2026-08-01T10:00:00.003Z');
    expect(latestDownloadRequestAt('2026-08-01T10:00:00Z', '2026-08-01T10:00:00.001Z')).toBe(
      '2026-08-01T10:00:00.001Z'
    );
    expect(latestDownloadRequestAt(undefined, null)).toBeNull();
  });

  test('DOWNLOAD-SYNC-05 preserves local state when cross-tab delivery fails', () => {
    const channel = new FakeChannel();
    channel.postError = new Error('BroadcastChannel delivery failed');
    const state = new Map<string, string>();
    const sync = createDownloadRequestSync({
      onupdate: (update) => merge(state, update),
      createChannel: () => channel
    });

    expect(() =>
      sync.publish({ outputId: 'output-a', requestedAt: '2026-08-01T10:00:00.000Z' })
    ).not.toThrow();
    expect(Object.fromEntries(state)).toEqual({
      'output-a': '2026-08-01T10:00:00.000Z'
    });
    sync.dispose();
  });

  test('DOWNLOAD-SYNC-06 merges per output and keeps the newest instant for one output', () => {
    const recorded = new Map<string, string>();

    const first = mergeDownloadRequest(recorded, {
      outputId: 'output-a',
      requestedAt: '2026-08-01T10:00:00.000Z'
    });
    const second = mergeDownloadRequest(first ?? recorded, {
      outputId: 'output-b',
      requestedAt: '2026-08-01T10:00:00.001Z'
    });
    const newer = mergeDownloadRequest(second ?? recorded, {
      outputId: 'output-a',
      requestedAt: '2026-08-01T10:00:00.002Z'
    });

    expect(Object.fromEntries(newer ?? new Map())).toEqual({
      'output-a': '2026-08-01T10:00:00.002Z',
      'output-b': '2026-08-01T10:00:00.001Z'
    });
    expect(
      mergeDownloadRequest(newer ?? recorded, {
        outputId: 'output-a',
        requestedAt: '2026-08-01T10:00:00.001Z'
      })
    ).toBeNull();
    expect(
      mergeDownloadRequest(newer ?? recorded, {
        outputId: 'output-a',
        requestedAt: '2026-08-01T10:00:00.002Z'
      })
    ).toBeNull();
    expect(
      mergeDownloadRequest(newer ?? recorded, { outputId: 'output-c', requestedAt: 'not-a-date' })
    ).toBeNull();
    expect(Object.fromEntries(recorded)).toEqual({});
  });

  test('DOWNLOAD-SYNC-07 collapses overlapping reconciliations into one trailing refresh', async () => {
    let running = 0;
    let peak = 0;
    let runs = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reconciler = createDownloadRequestReconciler(async () => {
      running += 1;
      peak = Math.max(peak, running);
      runs += 1;
      if (runs === 1) await gate;
      running -= 1;
    });

    const first = reconciler.request();
    const second = reconciler.request();
    const third = reconciler.request();
    expect(reconciler.pending).toBe(true);
    release?.();
    await Promise.all([first, second, third]);

    expect(runs).toBe(2);
    expect(peak).toBe(1);
    expect(reconciler.pending).toBe(false);
    await reconciler.request();
    expect(runs).toBe(3);
  });

  test('DOWNLOAD-SYNC-08 keeps reconciling after a failed refresh', async () => {
    const attempts: number[] = [];
    const reconciler = createDownloadRequestReconciler(async () => {
      attempts.push(attempts.length + 1);
      if (attempts.length === 1) throw new Error('Gallery data refresh failed.');
      await Promise.resolve();
    });

    await reconciler.request();
    expect(attempts).toEqual([1]);
    await reconciler.request();

    expect(attempts).toEqual([1, 2]);
    expect(reconciler.pending).toBe(false);
  });
});

describe('gallery download request reconciliation wiring', () => {
  test('DOWNLOAD-SYNC-09 invalidates a dependency the Gallery load actually declares', async () => {
    const contracts = await Bun.file('src/lib/features/library/contracts.ts').text();
    const load = await Bun.file('src/routes/gallery/+page.server.ts').text();
    const route = await Bun.file('src/routes/gallery/+page.svelte').text();

    expect(contracts).toContain("export const GALLERY_LIBRARY_DEPENDENCY = 'app:gallery-library';");
    expect(load).toContain('depends(GALLERY_LIBRARY_DEPENDENCY);');
    expect(route).toContain('invalidate(GALLERY_LIBRARY_DEPENDENCY)');
    expect(route).not.toContain('app:jobs-activity');
  });

  test('DOWNLOAD-SYNC-10 reconciles accepted, broadcast, and re-presented Gallery tabs', async () => {
    const route = await Bun.file('src/routes/gallery/+page.svelte').text();

    expect(route).toContain('createDownloadRequestSync({ onupdate: receiveDownloadRequest })');
    expect(route).toContain(
      'if (recordDownloadRequest(update)) void downloadReconciler?.request();'
    );
    expect(route).toContain('downloadRequestSync?.publish(update);');
    expect(route).toContain("document.addEventListener('visibilitychange', reconcileVisible);");
    expect(route).toContain("window.addEventListener('pageshow', reconcileRestored);");
    expect(route).toContain("document.removeEventListener('visibilitychange', reconcileVisible);");
    expect(route).toContain("window.removeEventListener('pageshow', reconcileRestored);");
  });
});
