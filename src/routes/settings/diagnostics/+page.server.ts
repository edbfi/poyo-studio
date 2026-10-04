import { getCleanupRuntime } from '#lib/server/cleanup/runtime.js';
import { buildOperationsDiagnostics } from '#lib/server/diagnostics/operations.js';
import { getPlatformServices } from '#lib/server/platform/runtime.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
  const [platform, cleanup] = await Promise.all([getPlatformServices(), getCleanupRuntime()]);
  return { diagnostics: await buildOperationsDiagnostics(platform, cleanup) };
};
