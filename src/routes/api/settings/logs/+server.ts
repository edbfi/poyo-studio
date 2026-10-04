import { operationsHttpError } from '#lib/server/operations/http.js';
import { maintenanceGate } from '#lib/server/platform/maintenance-gate.js';
import { readSameOriginJson } from '#lib/server/platform/request-security.js';
import { getPlatformServices } from '#lib/server/platform/runtime.js';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async ({ request }) => {
  let platform: Awaited<ReturnType<typeof getPlatformServices>> | null = null;
  let lease: Awaited<ReturnType<typeof maintenanceGate.upgradeToExclusiveMaintenance>> | null =
    null;
  try {
    const body = await readSameOriginJson<{ confirmed?: unknown }>(request, { maxBytes: 1024 });
    if (body.confirmed !== true) throw new Error('Log deletion requires explicit confirmation.');

    platform = await getPlatformServices();
    const initiator = maintenanceGate.acquireMaintenanceInitiator('http:log-clear');
    lease = await maintenanceGate.upgradeToExclusiveMaintenance(initiator);
    const result = await platform.logger.clearManagedFiles();
    platform.logger.resumeBeforePublication();
    lease.reopenBeforePublication();
    lease = null;
    return Response.json(result);
  } catch (error) {
    if (lease && platform) {
      try {
        platform.logger.resumeBeforePublication();
      } catch {
        // The logger may already have resumed before a later publication failure.
      }
      try {
        lease.reopenBeforePublication();
      } catch {
        // A finalized lease cannot be reopened twice.
      }
    }
    return operationsHttpError(error);
  }
};
