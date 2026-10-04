import { JobRequestError } from '#lib/server/jobs/create-request.js';
import { safeJobDto } from '#lib/server/jobs/events.js';
import { jobHttpError } from '#lib/server/jobs/http.js';
import { createManagedSourceUploadRefresher } from '#lib/server/jobs/managed-source-upload.js';
import { getJobRuntime } from '#lib/server/jobs/runtime.js';
import { maintenanceGate } from '#lib/server/platform/maintenance-gate.js';
import { readSameOriginJson } from '#lib/server/platform/request-security.js';
import { getPlatformServices } from '#lib/server/platform/runtime.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, params }) => {
  try {
    const body = await readSameOriginJson<{
      acknowledgeDuplicateSpendRisk: boolean;
      actionId: string;
    }>(request, { maxBytes: 1024 });
    if (body.acknowledgeDuplicateSpendRisk !== true)
      throw new JobRequestError(
        'duplicate_spend_acknowledgement_required',
        'Explicit acknowledgement of duplicate-spend risk is required.'
      );
    const platform = await getPlatformServices();
    const runtime = await getJobRuntime();
    const job = await runtime.repository.retryAmbiguous(
      params.jobId,
      body.actionId,
      createManagedSourceUploadRefresher(platform)
    );
    void maintenanceGate
      .trackDetached('jobs.reconcile-ambiguous', () => runtime.coordinator.reconcile(job.id))
      .catch(() => undefined);
    return Response.json({ job: safeJobDto(job) }, { status: 202 });
  } catch (error) {
    return jobHttpError(error);
  }
};
