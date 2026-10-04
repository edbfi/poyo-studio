import { createJobEventStream } from '#lib/server/jobs/events.js';
import { getJobRuntime } from '#lib/server/jobs/runtime.js';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = async ({ request }) => {
  const runtime = await getJobRuntime();
  const lastEventId =
    request.headers.get('last-event-id') ?? new URL(request.url).searchParams.get('lastEventId');
  return new Response(createJobEventStream(runtime.repository, lastEventId, request.signal), {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive'
    }
  });
};
