import { latestBalance, refreshBalance } from '#lib/server/account/balance.js';
import { jobHttpError } from '#lib/server/jobs/http.js';
import { readSameOriginJson } from '#lib/server/platform/request-security.js';
import { getPlatformServices } from '#lib/server/platform/runtime.js';
import type { RequestHandler } from './$types';

const noStore = { 'cache-control': 'private, no-store' };

export const GET: RequestHandler = async () => {
  const platform = await getPlatformServices();
  return Response.json(
    {
      balance: latestBalance(platform.database),
      apiKey: await platform.apiKey.status()
    },
    { headers: noStore }
  );
};

export const POST: RequestHandler = async ({ request }) => {
  try {
    await readSameOriginJson<Record<string, never>>(request, { maxBytes: 1024 });
    const platform = await getPlatformServices();
    return Response.json({ balance: await refreshBalance(platform) }, { headers: noStore });
  } catch (error) {
    const response = jobHttpError(error);
    response.headers.set('cache-control', 'no-store');
    return response;
  }
};
