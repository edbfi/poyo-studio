import { RequestSecurityError, readSameOriginJson } from '$lib/server/platform/request-security';
import { getPlatformServices } from '$lib/server/platform/runtime';
import { PresetRepository } from '$lib/server/presets/repository';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async ({ request, params }) => {
  try {
    await readSameOriginJson<Record<string, never>>(request, { maxBytes: 1024 });
    const platform = await getPlatformServices();
    const deleted = new PresetRepository(platform.database).delete(params.presetId);
    return deleted
      ? new Response(null, { status: 204 })
      : Response.json(
          { error: { code: 'preset_not_found', message: 'Preset not found.' } },
          { status: 404 }
        );
  } catch (error) {
    if (error instanceof RequestSecurityError)
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status }
      );
    return Response.json(
      { error: { code: 'preset_delete_failed', message: 'Preset could not be deleted.' } },
      { status: 400 }
    );
  }
};
