import { RequestSecurityError, readSameOriginJson } from '$lib/server/platform/request-security';
import { getPlatformServices } from '$lib/server/platform/runtime';
import { ModelPreferenceRepository } from '$lib/server/registry/preferences-repository';
import type { RequestHandler } from './$types';

type PreferenceBody = { entryKey: string; favorite?: boolean; used?: boolean };

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await readSameOriginJson<PreferenceBody>(request, { maxBytes: 4096 });
    const platform = await getPlatformServices();
    const preference = new ModelPreferenceRepository(platform.database).save(body.entryKey, {
      ...(body.favorite === undefined ? {} : { favorite: body.favorite }),
      ...(body.used === undefined ? {} : { used: body.used })
    });
    return Response.json({ preference });
  } catch (error) {
    if (error instanceof RequestSecurityError)
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status }
      );
    return Response.json(
      { error: { code: 'preference_invalid', message: 'Model preference could not be saved.' } },
      { status: 400 }
    );
  }
};
