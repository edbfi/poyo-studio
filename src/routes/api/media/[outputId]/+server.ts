import { serveVerifiedMediaOutput } from '#lib/server/media/verified-output.js';
import { getPlatformServices } from '#lib/server/platform/runtime.js';
import type { RequestHandler } from './$types';

async function serve(request: Request, outputId: string, head: boolean): Promise<Response> {
  const platform = await getPlatformServices();
  return serveVerifiedMediaOutput(request, platform.database, platform.paths.media, outputId, {
    head
  });
}

export const GET: RequestHandler = ({ request, params }) => serve(request, params.outputId, false);
export const HEAD: RequestHandler = ({ request, params }) => serve(request, params.outputId, true);
