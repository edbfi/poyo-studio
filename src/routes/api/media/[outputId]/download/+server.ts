import { MediaRangeError } from '$lib/server/media/files';
import {
  AttachmentRequestError,
  acceptVerifiedAttachmentRequest,
  authorizeAcceptedAttachmentRequest,
  MediaOutputError,
  serveVerifiedMediaOutput
} from '$lib/server/media/verified-output';
import { RequestSecurityError, readSameOriginJson } from '$lib/server/platform/request-security';
import { getPlatformServices } from '$lib/server/platform/runtime';
import type { RequestHandler } from './$types';

const privateNoStore = {
  'cache-control': 'private, no-store',
  'cross-origin-resource-policy': 'same-origin',
  'x-content-type-options': 'nosniff'
};

function errorResponse(status: number, head = false): Response {
  if (head) return new Response(null, { status, headers: privateNoStore });
  return Response.json(
    { error: 'Attachment request failed.' },
    { status, headers: privateNoStore }
  );
}

function statusForAttachmentError(error: unknown): number {
  if (
    error instanceof AttachmentRequestError ||
    error instanceof MediaOutputError ||
    error instanceof MediaRangeError ||
    error instanceof RequestSecurityError
  ) {
    return error.status;
  }
  if (error instanceof Error && /\bSQLITE_BUSY\b/i.test(error.message)) return 503;
  return 500;
}

function requestToken(request: Request): string | null {
  const values = new URL(request.url).searchParams.getAll('request');
  return values.length === 1 && values[0] ? values[0] : null;
}

async function serve(request: Request, outputId: string, head: boolean): Promise<Response> {
  const token = requestToken(request);
  if (!token) return errorResponse(400, head);

  try {
    const platform = await getPlatformServices();
    authorizeAcceptedAttachmentRequest(request, platform.database, outputId, token);
    return serveVerifiedMediaOutput(request, platform.database, platform.paths.media, outputId, {
      head,
      attachment: true
    });
  } catch (error) {
    return errorResponse(statusForAttachmentError(error), head);
  }
}

export const POST: RequestHandler = async ({ request, params }) => {
  try {
    const body = await readSameOriginJson<{ requestToken?: unknown }>(request, { maxBytes: 1024 });
    if (typeof body.requestToken !== 'string') return errorResponse(400);

    const platform = await getPlatformServices();
    const accepted = await acceptVerifiedAttachmentRequest(
      request,
      platform.database,
      platform.paths.media,
      params.outputId,
      body.requestToken
    );
    return Response.json(
      { accepted: true, requestedAt: accepted.requestedAt },
      { status: accepted.replayed ? 200 : 201, headers: privateNoStore }
    );
  } catch (error) {
    return errorResponse(statusForAttachmentError(error));
  }
};

export const GET: RequestHandler = ({ request, params }) => serve(request, params.outputId, false);
export const HEAD: RequestHandler = ({ request, params }) => serve(request, params.outputId, true);
