import { getPlatformServices } from '$lib/server/platform/runtime';
import { PresetRepository } from '$lib/server/presets/repository';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
  const platform = await getPlatformServices();
  return {
    presets: new PresetRepository(platform.database).list(),
    catalog: [...IMAGE_REGISTRY_ENTRIES, ...VIDEO_REGISTRY_ENTRIES].map((entry) => ({
      key: entry.key,
      displayName: entry.displayName,
      provider: entry.provider
    }))
  };
};

import { IMAGE_REGISTRY_ENTRIES } from '$lib/features/registry/image-registry';
import { VIDEO_REGISTRY_ENTRIES } from '$lib/features/registry/video-registry';
