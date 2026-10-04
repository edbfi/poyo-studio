import { parseJobFilters } from '#lib/features/library/presentation.js';
import { LibraryRepository } from '#lib/server/library/repository.js';
import { getPlatformServices } from '#lib/server/platform/runtime.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, depends }) => {
  const platform = await getPlatformServices();
  const repository = new LibraryRepository(platform.database);
  const filters = parseJobFilters(url.searchParams);
  depends('app:jobs-activity');
  return {
    filters,
    page: repository.listActivities(filters),
    filterOptions: repository.filterOptions()
  };
};
