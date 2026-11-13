import { describe, expect, test } from 'bun:test';
import { shouldRefreshJobDetail } from '../../../src/lib/features/library/job-detail-events';

const availabilityEventTypes = [
  'download.started',
  'download.verified',
  'output.local_file_removed',
  'output.local_metadata_removed',
  'output.local_both_removed'
];

function event(jobId: string, eventType: string): string {
  return JSON.stringify({ jobId, eventType });
}

describe('job detail durable event refreshes', () => {
  test('refreshes for every valid event belonging to the current job', () => {
    expect(shouldRefreshJobDetail(event('current', 'job.complete'), 'current', 'image')).toBe(true);
    expect(shouldRefreshJobDetail(event('current', 'status.observed'), 'current', 'video')).toBe(
      true
    );
  });

  test('refreshes image navigation for unrelated output availability changes', () => {
    for (const eventType of availabilityEventTypes) {
      expect(shouldRefreshJobDetail(event('other', eventType), 'current', 'image')).toBe(true);
    }
  });

  test('ignores ordinary lifecycle events from unrelated jobs', () => {
    expect(shouldRefreshJobDetail(event('other', 'job.complete'), 'current', 'image')).toBe(false);
    expect(shouldRefreshJobDetail(event('other', 'status.observed'), 'current', 'image')).toBe(
      false
    );
  });

  test('does not refresh video details for unrelated output availability changes', () => {
    for (const eventType of availabilityEventTypes) {
      expect(shouldRefreshJobDetail(event('other', eventType), 'current', 'video')).toBe(false);
    }
  });

  test('ignores malformed event payloads', () => {
    expect(shouldRefreshJobDetail('{', 'current', 'image')).toBe(false);
    expect(shouldRefreshJobDetail('null', 'current', 'image')).toBe(false);
    expect(shouldRefreshJobDetail(JSON.stringify({ jobId: 'current' }), 'current', 'image')).toBe(
      false
    );
    expect(
      shouldRefreshJobDetail(
        JSON.stringify({ jobId: 'current', eventType: 123 }),
        'current',
        'image'
      )
    ).toBe(false);
  });
  test('refreshes root and sibling detail for same-root status, cost and chain events only', () => {
    for (const current of ['root', 'child-a'])
      for (const eventType of ['status.observed', 'balance.cost.recorded', 'retry.exhausted']) {
        const same = JSON.stringify({
          jobId: 'child-b',
          eventType,
          payload: { automaticRetry: { rootId: 'root' } }
        });
        expect(shouldRefreshJobDetail(same, current, 'video', 'root')).toBe(true);
        expect(shouldRefreshJobDetail(same, current, 'image', 'root')).toBe(true);
        expect(shouldRefreshJobDetail(same, current, 'video', null)).toBe(false);
        expect(shouldRefreshJobDetail(same, current, 'video', 'other-root')).toBe(false);
      }
    for (const payload of [null, {}, { automaticRetry: null }, { automaticRetry: { rootId: 7 } }])
      expect(
        shouldRefreshJobDetail(
          JSON.stringify({ jobId: 'other', eventType: 'status.observed', payload }),
          'root',
          'image',
          'root'
        )
      ).toBe(false);
  });
});
