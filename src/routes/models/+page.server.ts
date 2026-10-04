import { modelCatalogue } from '#lib/features/registry/catalogue.js';
import { IMAGE_REGISTRY } from '#lib/features/registry/image-registry.js';
import { VIDEO_REGISTRY } from '#lib/features/registry/video-registry.js';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = ({ url }) => ({
  registry: {
    versions: [IMAGE_REGISTRY.version, VIDEO_REGISTRY.version],
    verifiedAt: VIDEO_REGISTRY.verifiedAt,
    pageCount: IMAGE_REGISTRY.pageCount + VIDEO_REGISTRY.pageCount,
    publicIdCount: IMAGE_REGISTRY.publicIdCount + VIDEO_REGISTRY.publicIdCount
  },
  models: modelCatalogue(url.searchParams.get('q') ?? '')
});
