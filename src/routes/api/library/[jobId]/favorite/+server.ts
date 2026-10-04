import { jobHttpError } from '#lib/server/jobs/http.js';
import { LibraryRepository } from '#lib/server/library/repository.js';
import { readSameOriginJson } from '#lib/server/platform/request-security.js';
import { getPlatformServices } from '#lib/server/platform/runtime.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, params }) => {
  try {
    const body = await readSameOriginJson<{ favorite: boolean }>(request, { maxBytes: 1024 });
    if (typeof body.favorite !== 'boolean') throw new Error('Favorite state is required.');
    const platform = await getPlatformServices();
    new LibraryRepository(platform.database).setFavorite(params.jobId, body.favorite);
    return Response.json({ favorite: body.favorite });
  } catch (error) {
    return jobHttpError(error);
  }
};
