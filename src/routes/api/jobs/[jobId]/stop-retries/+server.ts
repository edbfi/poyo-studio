import { safeJobDto } from '#lib/server/jobs/events.js';
import { jobHttpError } from '#lib/server/jobs/http.js';
import { getJobRuntime } from '#lib/server/jobs/runtime.js';
import { readSameOriginJson } from '#lib/server/platform/request-security.js';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = async ({ request, params }) => {
  try {
    await readSameOriginJson(request);
    const runtime = await getJobRuntime();
    runtime.repository.stopAutomaticRetries(params.jobId);
    const job = runtime.repository.get(params.jobId);
    return Response.json({ job: job ? safeJobDto(job) : null });
  } catch (error) {
    return jobHttpError(error);
  }
};
