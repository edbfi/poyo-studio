import type { Database } from 'bun:sqlite';
import type { LibraryFiltersDto } from '../../features/library/contracts';
import { isExactIsoUtcInstant } from '../../features/library/contracts';
import {
  LibraryRepository,
  ViewerSequenceChangedError,
  type ViewerSequenceQueryObserver,
  type ViewerSequenceTokenContext
} from './repository';

export interface ViewerSequenceHandlerDependencies {
  resolveDatabase: () => Database | Promise<Database>;
  tokenContext: ViewerSequenceTokenContext;
  queryObserver?: ViewerSequenceQueryObserver;
}

type ViewerSequenceEvent = { request: Request; url: URL };

const responseHeaders = {
  'cache-control': 'private, no-store',
  'cross-origin-resource-policy': 'same-origin',
  'x-content-type-options': 'nosniff'
};

function failure(status: number, code: string): Response {
  return Response.json({ error: code }, { status, headers: responseHeaders });
}

function value(url: URL, name: string, maximum = 256): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) return null;
  const result = values[0] ?? '';
  return result.length <= maximum ? result : null;
}

function validDate(date: string): boolean {
  if (!date) return true;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.getUTCFullYear() === Number(match[1]) &&
    parsed.getUTCMonth() === Number(match[2]) - 1 &&
    parsed.getUTCDate() === Number(match[3])
  );
}

function parseFilters(url: URL): Omit<LibraryFiltersDto, 'cursor' | 'view'> | null {
  const q = value(url, 'q');
  const mediaKind = value(url, 'mediaKind', 16);
  const model = value(url, 'model');
  const provider = value(url, 'provider');
  const workflow = value(url, 'workflow');
  const aspectRatio = value(url, 'aspectRatio');
  const status = value(url, 'status', 16);
  const tag = value(url, 'tag');
  const dateFrom = value(url, 'dateFrom', 10);
  const dateTo = value(url, 'dateTo', 10);
  const favorite = value(url, 'favorite', 5);
  if (
    q === null ||
    mediaKind === null ||
    model === null ||
    provider === null ||
    workflow === null ||
    aspectRatio === null ||
    status === null ||
    tag === null ||
    dateFrom === null ||
    dateTo === null ||
    favorite === null
  )
    return null;
  if (mediaKind !== '' && mediaKind !== 'image' && mediaKind !== 'video') return null;
  if (
    status !== '' &&
    status !== 'all' &&
    status !== 'available' &&
    status !== 'attention' &&
    status !== 'remote-only' &&
    status !== 'deleted'
  )
    return null;
  if (favorite !== '' && favorite !== 'true' && favorite !== 'false') return null;
  if (!validDate(dateFrom) || !validDate(dateTo) || (dateFrom && dateTo && dateFrom > dateTo))
    return null;
  return {
    q,
    mediaKind,
    model,
    provider,
    workflow,
    aspectRatio,
    status: status === '' ? 'all' : status,
    favorite: favorite === 'true',
    tag,
    dateFrom,
    dateTo
  };
}

function sameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return false;
  const fetchSite = request.headers.get('sec-fetch-site');
  return fetchSite !== 'cross-site';
}
function validPage(page: {
  items: Array<{
    jobId: string;
    outputId: string;
    mediaKind: string;
    mediaUrl: string;
    createdAt: string;
    downloadCopyRequestedAt?: string | null;
    downloadCopyRequestCount?: number;
  }>;
  nextCursor: string | null;
  snapshot: string;
  total: number | null;
}): boolean {
  if (
    page.items.length > 200 ||
    (page.nextCursor !== null &&
      (typeof page.nextCursor !== 'string' || page.nextCursor.length > 512)) ||
    typeof page.snapshot !== 'string' ||
    page.snapshot.length > 1024 ||
    (page.total !== null && (!Number.isSafeInteger(page.total) || page.total < 0))
  )
    return false;
  const jobs = new Set<string>();
  const outputs = new Set<string>();
  let previous: [string, string] | null = null;
  for (const item of page.items) {
    const downloadCopyRequestedAt = item.downloadCopyRequestedAt ?? null;
    const downloadCopyRequestCount = item.downloadCopyRequestCount ?? 0;
    if (
      typeof item.jobId !== 'string' ||
      !item.jobId ||
      typeof item.outputId !== 'string' ||
      !item.outputId ||
      !['image', 'video'].includes(item.mediaKind) ||
      !isExactIsoUtcInstant(item.createdAt) ||
      item.mediaUrl !== `/api/media/${encodeURIComponent(item.outputId)}` ||
      (downloadCopyRequestedAt !== null && !isExactIsoUtcInstant(downloadCopyRequestedAt)) ||
      !Number.isSafeInteger(downloadCopyRequestCount) ||
      downloadCopyRequestCount < 0 ||
      (downloadCopyRequestCount === 0) !== (downloadCopyRequestedAt === null) ||
      jobs.has(item.jobId) ||
      outputs.has(item.outputId)
    )
      return false;
    const tuple: [string, string] = [item.createdAt, item.jobId];
    if (
      previous &&
      (tuple[0] > previous[0] || (tuple[0] === previous[0] && tuple[1] >= previous[1]))
    )
      return false;
    previous = tuple;
    jobs.add(item.jobId);
    outputs.add(item.outputId);
  }
  return true;
}

export function createViewerSequenceHandler(
  dependencies: ViewerSequenceHandlerDependencies
): (event: ViewerSequenceEvent) => Promise<Response> {
  return async ({ request, url }) => {
    if (request.method !== 'GET') return failure(405, 'method_not_allowed');
    if (!sameOrigin(request, url)) return failure(403, 'forbidden');
    if (request.signal.aborted) return failure(499, 'aborted');
    const filters = parseFilters(url);
    const cursor = value(url, 'cursor', 512);
    const snapshot = value(url, 'snapshot', 1024);
    const limitValue = value(url, 'limit', 3);
    if (!filters || cursor === null || snapshot === null || limitValue === null)
      return failure(400, 'invalid_request');
    const limit = limitValue ? Number(limitValue) : 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      return failure(400, 'invalid_request');
    if (Boolean(cursor) !== Boolean(snapshot) || (!cursor && snapshot))
      return failure(400, 'invalid_request');
    try {
      const database = await dependencies.resolveDatabase();
      if (request.signal.aborted) return failure(499, 'aborted');
      const page = new LibraryRepository(database).listViewerSequence(
        filters,
        cursor || null,
        snapshot || null,
        limit,
        dependencies.tokenContext,
        dependencies.queryObserver
      );
      if (!validPage(page)) return failure(500, 'viewer_sequence_failed');
      if (request.signal.aborted) return failure(499, 'aborted');
      return Response.json(page, { headers: responseHeaders });
    } catch (error) {
      if (error instanceof ViewerSequenceChangedError)
        return failure(409, 'viewer_sequence_changed');
      return failure(500, 'viewer_sequence_failed');
    }
  };
}
