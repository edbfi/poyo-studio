import { GALLERY_LIBRARY_DEPENDENCY } from '#lib/features/library/contracts.js';
import { parseLibraryFilters } from '#lib/features/library/presentation.js';
import { LibraryRepository } from '#lib/server/library/repository.js';
import { getPlatformServices } from '#lib/server/platform/runtime.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ depends, url }) => {
  depends(GALLERY_LIBRARY_DEPENDENCY);
  const platform = await getPlatformServices();
  const repository = new LibraryRepository(platform.database);
  const filters = parseLibraryFilters(url.searchParams);
  return {
    filters,
    page: repository.listLibrary(filters),
    filterOptions: repository.filterOptions(),
    storage: await repository.storageStatistics(platform.paths)
  };
};
