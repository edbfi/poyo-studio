import type {
  DashboardDto,
  JobFiltersDto,
  LibraryFiltersDto
} from '#lib/features/library/contracts.js';
import {
  IMAGE_REGISTRY_ENTRIES,
  IMAGE_VERIFIED_AT
} from '#lib/features/registry/image-registry.js';
import {
  VIDEO_REGISTRY_ENTRIES,
  VIDEO_VERIFIED_AT
} from '#lib/features/registry/video-registry.js';
import { latestBalance } from '#lib/server/account/balance.js';
import { buildHealthDto } from '#lib/server/diagnostics/health.js';
import { LibraryRepository } from '#lib/server/library/repository.js';
import { getPlatformServices } from '#lib/server/platform/runtime.js';
import type { PageServerLoad } from './$types';

const jobFilters = (status: JobFiltersDto['status']): JobFiltersDto => ({
  status,
  q: '',
  model: '',
  workflow: '',
  dateFrom: '',
  dateTo: '',
  cursor: ''
});

const libraryFilters: LibraryFiltersDto = {
  q: '',
  mediaKind: '',
  model: '',
  provider: '',
  workflow: '',
  aspectRatio: '',
  status: 'all',
  favorite: false,
  tag: '',
  dateFrom: '',
  dateTo: '',
  cursor: '',
  view: 'grid'
};

export const load: PageServerLoad = async () => {
  const platform = await getPlatformServices();
  const repository = new LibraryRepository(platform.database);
  const apiKey = await platform.apiKey.status();
  const health = await buildHealthDto({
    database: platform.database,
    apiKey,
    logger: platform.logger
  });
  const data: DashboardDto = {
    balance: latestBalance(platform.database),
    active: [
      ...repository.listJobs(jobFilters('running'), 4).items,
      ...repository.listJobs(jobFilters('queued'), 4).items
    ].slice(0, 6),
    attention: repository.listJobs(jobFilters('attention'), 5).items,
    recent: repository.listLibrary(libraryFilters, 6).items,
    storage: await repository.storageStatistics(platform.paths),
    registry: {
      imageWorkflows: IMAGE_REGISTRY_ENTRIES.length,
      videoWorkflows: VIDEO_REGISTRY_ENTRIES.length,
      verifiedAt: IMAGE_VERIFIED_AT >= VIDEO_VERIFIED_AT ? IMAGE_VERIFIED_AT : VIDEO_VERIFIED_AT
    },
    health: {
      status: health.status,
      checkedAt: health.checkedAt,
      apiKeyStatus: apiKey.status
    }
  };
  return { dashboard: data };
};
