import type { SavePresetRequest } from '$lib/features/presets/types';
import { RequestSecurityError, readSameOriginJson } from '$lib/server/platform/request-security';
import { getPlatformServices } from '$lib/server/platform/runtime';
import { PresetRepository } from '$lib/server/presets/repository';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
  const platform = await getPlatformServices();
  return Response.json({ presets: new PresetRepository(platform.database).list() });
};

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await readSameOriginJson<SavePresetRequest>(request, { maxBytes: 256 * 1024 });
    const platform = await getPlatformServices();
    const preset = new PresetRepository(platform.database).save(body);
    return Response.json({ preset }, { status: body.id ? 200 : 201 });
  } catch (error) {
    if (error instanceof RequestSecurityError)
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status }
      );
    return Response.json(
      {
        error: {
          code: 'preset_invalid',
          message: error instanceof Error ? error.message : 'Preset could not be saved.'
        }
      },
      { status: 400 }
    );
  }
};
