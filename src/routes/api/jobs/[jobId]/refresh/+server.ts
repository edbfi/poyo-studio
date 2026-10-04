import { safeJobDto } from '#lib/server/jobs/events.js';
import { jobHttpError } from '#lib/server/jobs/http.js';
import { getJobRuntime } from '#lib/server/jobs/runtime.js';
import { readSameOriginJson } from '#lib/server/platform/request-security.js';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = async ({ request, params }) => {
  try {
    await readSameOriginJson<Record<string, never>>(request, { maxBytes: 1024 });
    const runtime = await getJobRuntime();
    const job = await runtime.coordinator.poll(params.jobId, true);
    return Response.json({ job: safeJobDto(job) });
  } catch (error) {
    return jobHttpError(error);
  }
};
