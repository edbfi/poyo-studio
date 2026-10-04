import { jobHttpError } from '#lib/server/jobs/http.js';
import { LibraryRepository } from '#lib/server/library/repository.js';
import { readSameOriginJson } from '#lib/server/platform/request-security.js';
import { getPlatformServices } from '#lib/server/platform/runtime.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, params }) => {
  try {
    const body = await readSameOriginJson<{ pinned: boolean }>(request, { maxBytes: 1024 });
    if (typeof body.pinned !== 'boolean') throw new Error('Pinned state is required.');
    const platform = await getPlatformServices();
    new LibraryRepository(platform.database).setPinned(params.jobId, body.pinned);
    return Response.json({ pinned: body.pinned });
  } catch (error) {
    return jobHttpError(error);
  }
};
