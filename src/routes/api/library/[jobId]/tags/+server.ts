import { jobHttpError } from '$lib/server/jobs/http';
import { LibraryRepository } from '$lib/server/library/repository';
import { readSameOriginJson } from '$lib/server/platform/request-security';
import { getPlatformServices } from '$lib/server/platform/runtime';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, params }) => {
  try {
    const body = await readSameOriginJson<{ tags: string[] }>(request, { maxBytes: 8 * 1024 });
    if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== 'string'))
      throw new Error('Tags must be a list of names.');
    const platform = await getPlatformServices();
    const tags = new LibraryRepository(platform.database).replaceTags(params.jobId, body.tags);
    return Response.json({ tags });
  } catch (error) {
    return jobHttpError(error);
  }
};
