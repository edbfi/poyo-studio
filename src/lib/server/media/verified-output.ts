import type { Database } from 'bun:sqlite';
import { basename } from 'node:path';
import {
  assertPrivateMediaRequest,
  MediaRangeError,
  parseByteRange,
  privateMediaHeaders,
  safeLocalMediaPath
} from './files';

const allowedTypes = new Set([
  'image/svg+xml',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'video/x-matroska',
  'video/quicktime'
]);

export class MediaOutputError extends Error {
  constructor(
    readonly code: 'local_media_unavailable',
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'MediaOutputError';
  }
}

export interface VerifiedMediaOutput {
  outputId: string;
  path: string;
  fileName: string;
  contentType: string;
  size: number;
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AttachmentRequestError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'unknown_request'
      | 'request_output_mismatch'
      | 'request_busy',
    readonly status: 400 | 404 | 409 | 503,
    message: string
  ) {
    super(message);
    this.name = 'AttachmentRequestError';
  }
}

export interface AcceptedAttachmentRequest {
  requestedAt: string;
  replayed: boolean;
}

function assertAttachmentRequestValues(outputId: string, requestToken: string): void {
  if (!uuidPattern.test(outputId) || !uuidPattern.test(requestToken)) {
    throw new AttachmentRequestError('invalid_request', 400, 'Attachment request is invalid.');
  }
}

function isDatabaseBusy(error: unknown): boolean {
  return error instanceof Error && /\bSQLITE_BUSY\b/i.test(error.message);
}

export async function acceptVerifiedAttachmentRequest(
  request: Request,
  database: Database,
  mediaRoot: string,
  outputId: string,
  requestToken: string
): Promise<AcceptedAttachmentRequest> {
  assertPrivateMediaRequest(request);
  assertAttachmentRequestValues(outputId, requestToken);
  await resolveVerifiedMediaOutput(database, mediaRoot, outputId);

  const requestedAt = new Date().toISOString();
  try {
    return database.transaction(() => {
      const existing = database
        .query<{ job_output_id: string; requested_at: string }, [string]>(
          'SELECT job_output_id,requested_at FROM attachment_requests WHERE request_token=?'
        )
        .get(requestToken);
      if (existing) {
        if (existing.job_output_id !== outputId) {
          throw new AttachmentRequestError(
            'request_output_mismatch',
            409,
            'Attachment request conflicts with this output.'
          );
        }
        return { requestedAt: existing.requested_at, replayed: true };
      }

      database
        .query(
          'INSERT INTO attachment_requests(id,request_token,job_output_id,requested_at) VALUES (?,?,?,?)'
        )
        .run(crypto.randomUUID(), requestToken, outputId, requestedAt);
      return { requestedAt, replayed: false };
    })();
  } catch (error) {
    if (error instanceof AttachmentRequestError) throw error;
    if (isDatabaseBusy(error)) {
      throw new AttachmentRequestError('request_busy', 503, 'Attachment requests are busy.');
    }
    try {
      const existing = database
        .query<{ job_output_id: string; requested_at: string }, [string]>(
          'SELECT job_output_id,requested_at FROM attachment_requests WHERE request_token=?'
        )
        .get(requestToken);
      if (!existing) throw error;
      if (existing.job_output_id !== outputId) {
        throw new AttachmentRequestError(
          'request_output_mismatch',
          409,
          'Attachment request conflicts with this output.'
        );
      }
      return { requestedAt: existing.requested_at, replayed: true };
    } catch (recoveryError) {
      if (isDatabaseBusy(recoveryError)) {
        throw new AttachmentRequestError('request_busy', 503, 'Attachment requests are busy.');
      }
      throw recoveryError;
    }
  }
}

export function authorizeAcceptedAttachmentRequest(
  request: Request,
  database: Database,
  outputId: string,
  requestToken: string
): void {
  assertPrivateMediaRequest(request);
  assertAttachmentRequestValues(outputId, requestToken);
  const accepted = database
    .query<{ job_output_id: string }, [string]>(
      'SELECT job_output_id FROM attachment_requests WHERE request_token=?'
    )
    .get(requestToken);
  if (!accepted) {
    throw new AttachmentRequestError('unknown_request', 404, 'Attachment request was not found.');
  }
  if (accepted.job_output_id !== outputId) {
    throw new AttachmentRequestError(
      'request_output_mismatch',
      409,
      'Attachment request conflicts with this output.'
    );
  }
}

export async function resolveVerifiedMediaOutput(
  database: Database,
  mediaRoot: string,
  outputId: string
): Promise<VerifiedMediaOutput> {
  const output = database
    .query<
      { local_path: string | null; content_type: string | null; download_state: string },
      [string]
    >('SELECT local_path,content_type,download_state FROM job_outputs WHERE id=?')
    .get(outputId);
  if (!output?.local_path || output.download_state !== 'verified') {
    throw new MediaOutputError(
      'local_media_unavailable',
      404,
      'This output is not available locally.'
    );
  }
  const path = await safeLocalMediaPath(mediaRoot, output.local_path).catch(() => {
    throw new MediaOutputError(
      'local_media_unavailable',
      404,
      'This output is not available locally.'
    );
  });
  const file = Bun.file(path);
  if (!(await file.exists()) || file.size <= 0) {
    throw new MediaOutputError(
      'local_media_unavailable',
      404,
      'This output is not available locally.'
    );
  }
  const contentType =
    output.content_type && allowedTypes.has(output.content_type)
      ? output.content_type
      : allowedTypes.has(file.type)
        ? file.type
        : 'application/octet-stream';
  return {
    outputId,
    path,
    fileName: basename(path),
    contentType,
    size: file.size
  };
}

function contentDisposition(fileName: string): string {
  const fallback =
    fileName
      .normalize('NFKD')
      .replace(/[^\x20-\x7e]/g, '')
      .replace(/["\\]/g, '_')
      .trim() || 'output';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function serveVerifiedMediaOutput(
  request: Request,
  database: Database,
  mediaRoot: string,
  outputId: string,
  options: { head?: boolean; attachment?: boolean } = {}
): Promise<Response> {
  let size: number | null = null;
  try {
    assertPrivateMediaRequest(request);
    const output = await resolveVerifiedMediaOutput(database, mediaRoot, outputId);
    size = output.size;
    const file = Bun.file(output.path);
    const range = parseByteRange(request.headers.get('range'), output.size);
    const headers = privateMediaHeaders(
      output.contentType,
      range ? range.end - range.start + 1 : output.size
    );
    if (options.attachment) {
      headers.set('cache-control', 'private, no-store');
      headers.set('content-disposition', contentDisposition(output.fileName));
    }
    if (range) {
      headers.set('content-range', `bytes ${range.start}-${range.end}/${output.size}`);
      return new Response(options.head ? null : file.slice(range.start, range.end + 1), {
        status: 206,
        headers
      });
    }
    return new Response(options.head ? null : file, { headers });
  } catch (error) {
    if (error instanceof MediaRangeError) {
      const headers = new Headers({
        'cross-origin-resource-policy': 'same-origin',
        'x-content-type-options': 'nosniff'
      });
      if (error.status === 416 && size !== null) headers.set('content-range', `bytes */${size}`);
      return new Response(options.head ? null : error.message, { status: error.status, headers });
    }
    return new Response(options.head ? null : 'Local media is unavailable.', { status: 404 });
  }
}
