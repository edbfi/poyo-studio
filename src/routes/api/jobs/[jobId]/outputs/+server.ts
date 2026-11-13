import { getJobRuntime } from '#lib/server/jobs/runtime.js';
import { studioOutputMetadata } from '#lib/server/jobs/studio-output-metadata.js';
import { LibraryRepository } from '#lib/server/library/repository.js';
import { getPlatformServices } from '#lib/server/platform/runtime.js';
import type { RequestHandler } from './$types';

/**
 * Output metadata for a remotely finished job, including downloads Studio can repair.
 * `mediaUrl` is populated only for locally verified outputs; failed downloads retain metadata.
 */
export const GET: RequestHandler = async ({ params, setHeaders }) => {
  setHeaders({ 'cache-control': 'no-store' });
  const platform = await getPlatformServices();
  const runtime = await getJobRuntime();
  const detail = await new LibraryRepository(platform.database).getJobDetail(params.jobId);
  // Return JSON (matching the success shape and the sibling api/jobs job_not_found response) so the
  // studio's loadOutputs(), which always `await response.json()`s, can read a not-found error rather
  // than hitting a parse failure that erases the 404 context.
  if (!detail) return Response.json({ error: { code: 'job_not_found' } }, { status: 404 });
  const outputs = studioOutputMetadata(detail);
  return Response.json({
    outputs,
    actualCredits: detail.actualCredits,
    taskCharge: runtime.repository.taskCharge(params.jobId)
  });
};
