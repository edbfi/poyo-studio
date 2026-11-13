import type { JobProviderDiagnostic } from '../diagnostics/provider-diagnostic';
import type { AutomaticRetry, LocalOutcome } from '../generation/retries';

const exactIsoUtcInstant = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{3})?Z$/;

export function isExactIsoUtcInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = exactIsoUtcInstant.exec(value);
  if (!match) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== Number(match[1]) ||
    parsed.getUTCMonth() !== Number(match[2]) - 1 ||
    parsed.getUTCDate() !== Number(match[3]) ||
    parsed.getUTCHours() !== Number(match[4]) ||
    parsed.getUTCMinutes() !== Number(match[5]) ||
    parsed.getUTCSeconds() !== Number(match[6])
  )
    return false;
  return parsed.toISOString() === `${value.slice(0, -1)}${match[7] ? 'Z' : '.000Z'}`;
}
export type JobFilterStatus =
  | 'all'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'attention'
  | 'stale'
  | 'stopped';

export type LibraryStatus = 'all' | 'available' | 'attention' | 'remote-only' | 'deleted';

/**
 * Load dependency for authoritative Gallery library data, including accepted download-copy
 * requests. Invalidate it to reconcile a Gallery view with persisted state.
 */
export const GALLERY_LIBRARY_DEPENDENCY = 'app:gallery-library';

export interface ModelFilterOption {
  publicModelId: string;
  displayName: string;
  provider: string;
  workflow: string;
  modality: 'image' | 'video';
}

export interface SafeMediaSummary {
  outputId: string;
  mediaKind: 'image' | 'video';
  contentType: string | null;
  fileName: string | null;
  pixelWidth: number | null;
  pixelHeight: number | null;
  downloadState: 'pending' | 'downloading' | 'verified' | 'failed' | 'expired' | 'deleted';
  mediaUrl: string | null;
  downloadCopyRequestedAt?: string | null;
  downloadCopyRequestCount?: number;
}

export interface JobListItemDto {
  automaticRetry?: AutomaticRetry | null;
  localOutcome?: LocalOutcome | null;
  id: string;
  entryKey: string | null;
  displayName: string;
  provider: string;
  modality: 'image' | 'video';
  workflow: string;
  publicModelId: string;
  localPhase: string;
  remoteStatus: string;
  failureDomain: string;
  attentionCode: string | null;
  ipGuardReason: 'match' | 'unavailable' | 'misconfigured' | null;
  progress: number | null;
  estimatedCredits: number | null;
  actualCredits: number | null;
  lastPolledAt: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  promptExcerpt: string | null;
  outputCount: number;
  verifiedOutputCount: number;
  outputState: string | null;
  representative: SafeMediaSummary | null;
}
export type ActivityCostDto =
  | { kind: 'not-submitted'; credits: 0; source: 'not-submitted'; settledAt: string }
  | {
      kind: 'charge';
      credits: number;
      terminalStatus: 'finished' | 'failed' | 'cancelled';
      settledAt: string;
    }
  | {
      kind: 'estimate';
      credits: number;
      provenance: 'published' | 'observed' | 'blend';
      sourceVerifiedAt: string | null;
    }
  | { kind: 'unavailable' };

export type JobActivityDto =
  | {
      kind: 'job-created';
      id: string;
      occurredAt: string;
      job: JobListItemDto;
      cost: ActivityCostDto;
    }
  | {
      kind: 'attachment-request';
      id: string;
      occurredAt: string;
      job: JobListItemDto;
      fileName: string | null;
      cost: null;
    };
export interface JobChronologyNeighborDto {
  jobId: string;
  displayName: string;
  createdAt: string;
}

export interface ImageJobNavigationDto {
  previous: JobChronologyNeighborDto | null;
  next: JobChronologyNeighborDto | null;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

export interface JobFiltersDto {
  status: JobFilterStatus;
  q: string;
  model: string;
  workflow: string;
  dateFrom: string;
  dateTo: string;
  cursor: string;
}

export interface LibraryFiltersDto {
  q: string;
  mediaKind: '' | 'image' | 'video';
  model: string;
  provider: string;
  workflow: string;
  aspectRatio: string;
  status: LibraryStatus;
  favorite: boolean;
  tag: string;
  dateFrom: string;
  dateTo: string;
  cursor: string;
  view: 'grid' | 'list';
}
export interface GalleryViewerItemDto {
  jobId: string;
  displayName: string;
  provider: string;
  workflow: string;
  promptExcerpt: string | null;
  createdAt: string;
  outputId: string;
  mediaKind: 'image' | 'video';
  mediaUrl: string;
  downloadCopyRequestedAt?: string | null;
  downloadCopyRequestCount?: number;
}

export interface GalleryViewerSequencePageDto {
  items: GalleryViewerItemDto[];
  nextCursor: string | null;
  snapshot: string;
  total: number | null;
}

export interface JobInputDto {
  role: string;
  inputOrder: number;
  mediaKind: 'image' | 'video';
  sourceKind: 'local' | 'remote' | 'uploaded' | 'unknown';
  sourceLabel: string;
  originalName: string | null;
  neutralUploadName: string | null;
  availability: string;
  byteSize: number | null;
  localConsequence: 'retained' | 'missing' | 'deleted' | 'not-managed';
}

export interface DownloadAttemptDto {
  attempt: number;
  status: 'started' | 'verified' | 'failed' | 'expired';
  bytesReceived: number;
  startedAt: string;
  completedAt: string | null;
}

export interface JobOutputDto extends SafeMediaSummary {
  outputOrder: number;
  remoteAvailable: boolean;
  remoteHost: string | null;
  remoteExpiresAt: string | null;
  byteSize: number | null;
  aspectRatio: string | null;
  favorite: boolean;
  pinned: boolean;
  localAvailable: boolean;
  verifiedAt: string | null;
  deletedAt: string | null;
  attempts: DownloadAttemptDto[];
}

export interface JobHistoryDto {
  providerDiagnostic?: JobProviderDiagnostic;
  eventId: number;
  eventType: string;
  localPhase: string;
  remoteStatus: string;
  failureDomain: string;
  progress: number | null;
  observedAt: string;
  authority: 'poyo' | 'local';
}

export interface SafeConfigurationFieldDto {
  key:
    | 'aspectRatio'
    | 'size'
    | 'resolution'
    | 'width'
    | 'height'
    | 'duration'
    | 'fps'
    | 'frames'
    | 'seed'
    | 'steps'
    | 'guidanceScale'
    | 'promptStrength'
    | 'outputCount';
  label: string;
  value: string;
}

export interface RetryAttemptSummaryDto {
  id: string;
  ordinal: number;
  remoteStatus: string;
  localPhase: string;
  localOutcome: import('../generation/retries').LocalOutcome | null;
  chargedCredits: number | null;
}
export interface JobDetailDto extends JobListItemDto {
  retryAttempts?: RetryAttemptSummaryDto[];
  prompt: string | null;
  poyoTaskLinked: boolean;
  submissionState: string | null;
  cost: ActivityCostDto;
  configuration: SafeConfigurationFieldDto[];
  requestedAspectRatio: string | null;
  inputs: JobInputDto[];
  outputs: JobOutputDto[];
  history: JobHistoryDto[];
  tags: string[];
}

export interface LibraryGroupDto {
  jobId: string;
  entryKey: string | null;
  displayName: string;
  provider: string;
  modality: 'image' | 'video';
  workflow: string;
  publicModelId: string;
  promptExcerpt: string | null;
  createdAt: string;
  completedAt: string | null;
  outputCount: number;
  verifiedOutputCount: number;
  totalBytes: number;
  favorite: boolean;
  pinned: boolean;
  aspectRatio: string | null;
  warning: string | null;
  tags: string[];
  representative: SafeMediaSummary | null;
}

export interface StorageStatisticsDto {
  indexedBytes: number;
  verifiedFiles: number;
  missingOrDeletedFiles: number;
  generatedBytes: number;
  managedSourceBytes: number;
  managedSourceFiles: number;
  missingOrDeletedSources: number;
  capacityBytes: number | null;
  freeBytes: number | null;
}

export interface JobFilterOptionsDto {
  models: ModelFilterOption[];
  workflows: string[];
  providers: string[];
  tags: string[];
}

export interface DashboardDto {
  balance: { email: string | null; credits: number; fetchedAt: string } | null;
  active: JobListItemDto[];
  attention: JobListItemDto[];
  recent: LibraryGroupDto[];
  storage: StorageStatisticsDto;
  registry: { imageWorkflows: number; videoWorkflows: number; verifiedAt: string };
  health: { status: 'ok' | 'degraded'; checkedAt: string; apiKeyStatus: string };
}

export type LocalDeleteChoice = 'file' | 'metadata' | 'both';
