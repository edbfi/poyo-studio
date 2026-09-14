import { safeJobDto } from '$lib/server/jobs/events';
import { jobHttpError } from '$lib/server/jobs/http';
import { getJobRuntime } from '$lib/server/jobs/runtime';
import { readSameOriginJson } from '$lib/server/platform/request-security';
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
