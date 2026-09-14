import type { LocalDeleteChoice } from '$lib/features/library/contracts';
import { jobHttpError } from '$lib/server/jobs/http';
import { LibraryRepository } from '$lib/server/library/repository';
import { readSameOriginJson } from '$lib/server/platform/request-security';
import { getPlatformServices } from '$lib/server/platform/runtime';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, params }) => {
  try {
    const body = await readSameOriginJson<{ choice: LocalDeleteChoice }>(request, {
      maxBytes: 1024
    });
    if (!['file', 'metadata', 'both'].includes(body.choice))
      throw new Error('Choose which local data to remove.');
    const platform = await getPlatformServices();
    await new LibraryRepository(platform.database).deleteOutput(
      params.jobId,
      params.outputId,
      body.choice,
      platform.paths
    );
    return Response.json({ removed: body.choice });
  } catch (error) {
    return jobHttpError(error);
  }
};
