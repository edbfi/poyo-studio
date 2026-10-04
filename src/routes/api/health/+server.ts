import { json } from '@sveltejs/kit';
import { buildHealthDto } from '#lib/server/diagnostics/health.js';
import { getPlatformServices } from '#lib/server/platform/runtime.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ setHeaders }) => {
  setHeaders({ 'cache-control': 'no-store' });

  try {
    const services = await getPlatformServices();
    const apiKey = await services.apiKey.status();
    return json(
      await buildHealthDto({ database: services.database, apiKey, logger: services.logger })
    );
  } catch {
    return json(
      {
        status: 'degraded',
        checkedAt: new Date().toISOString(),
        error: {
          name: 'PlatformInitializationError',
          message: 'Local platform initialization failed. Review the redacted local logs.'
        }
      },
      { status: 503 }
    );
  }
};
