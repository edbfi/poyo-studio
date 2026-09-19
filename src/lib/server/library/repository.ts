import type { Database } from 'bun:sqlite';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { basename } from 'node:path';
import type {
  CursorPage,
  DownloadAttemptDto,
  GalleryViewerItemDto,
  GalleryViewerSequencePageDto,
  ImageJobNavigationDto,
  JobActivityDto,
  JobChronologyNeighborDto,
  JobDetailDto,
  JobFilterOptionsDto,
  JobFiltersDto,
  JobHistoryDto,
  JobInputDto,
  JobListItemDto,
  JobOutputDto,
  LibraryFiltersDto,
  LibraryGroupDto,
  LocalDeleteChoice,
  ModelFilterOption,
  SafeConfigurationFieldDto,
  SafeMediaSummary,
  StorageStatisticsDto
} from '../../features/library/contracts';
import { isExactIsoUtcInstant } from '../../features/library/contracts';
import { modelCatalogue } from '../../features/registry/catalogue';
import { IMAGE_REGISTRY_ENTRIES } from '../../features/registry/image-registry';
import { VIDEO_REGISTRY_ENTRIES } from '../../features/registry/video-registry';
import { packDurableJobEventPayload } from '../jobs/event-attention';
import { taskChargeFromParts } from '../jobs/repository';
import type { RemoteStatus } from '../jobs/types';
import { ManagedSourceRepository } from '../media/managed-sources';
import { neutralSourceUploadName } from '../media/source-intake';
import { MediaOutputError, resolveVerifiedMediaOutput } from '../media/verified-output';
import { type AppPaths, resolvePathWithin } from '../platform/app-paths';
import { DatabaseRepository } from '../platform/repository';
import { publicIpv4GuardReason } from '../poyo/errors';

export type ViewerSequenceQueryBinding = string | number | null;
type Binding = ViewerSequenceQueryBinding;
export interface ViewerSequenceTokenContext {
  secret: Uint8Array;
  nonce: string;
}

export interface ViewerSequenceQueryObservation {
  phase: 'initial' | 'intermediate' | 'terminal';
  operation: 'marker' | 'count' | 'page-seek' | 'page-hydrate';
  bindings: number;
  rows: number;
  diagnostics?: string[];
}

export type ViewerSequenceQueryObserver = (observation: ViewerSequenceQueryObservation) => void;
export interface ViewerSequenceQueryPlan {
  countSql: string;
  countBindings: ViewerSequenceQueryBinding[];
  pageSeekSql: string;
  pageSeekBindings: ViewerSequenceQueryBinding[];
}

export class ViewerSequenceChangedError extends Error {
  constructor() {
    super('Viewer sequence changed.');
    this.name = 'ViewerSequenceChangedError';
  }
}

type JobListRow = {
  id: string;
  entry_key: string | null;
  workflow: string;
  public_model_id: string;
  local_phase: string;
  remote_status: RemoteStatus;
  remote_status_raw: string | null;
  failure_domain: string;
  attention_code: string | null;
  progress: number | null;
  estimated_credits: number | null;
  actual_credits: number | null;
  prompt_text: string | null;
  last_polled_at: string | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  completed_at: string | null;
  output_count: number;
  verified_count: number;
  output_state: string | null;
  representative_id: string | null;
  representative_kind: 'image' | 'video' | null;
  representative_type: string | null;
  representative_state: SafeMediaSummary['downloadState'] | null;
  representative_path: string | null;
  representative_width: number | null;
  representative_height: number | null;
  representative_copy_requested_at: string | null;
  representative_copy_request_count: number;
};
type ActivityRow = JobListRow & {
  activity_kind: 'job-created' | 'attachment-request';
  occurred_at: string;
  kind_ordinal: number;
  tie_id: string;
  attachment_path: string | null;
  estimate_json: string | null;
};

type ActivityCursor = {
  occurredAt: string;
  kindOrdinal: number;
  tieId: string;
};

type LibraryRow = {
  id: string;
  entry_key: string | null;
  workflow: string;
  public_model_id: string;
  prompt_text: string | null;
  created_at: string;
  completed_at: string | null;
  output_count: number;
  verified_count: number;
  total_bytes: number;
  favorite: number;
  pinned: number;
  aspect_ratio: string | null;
  warning: string | null;
  attention_code: string | null;
  tags_json: string;
  representative_id: string | null;
  representative_kind: 'image' | 'video' | null;
  representative_type: string | null;
  representative_state: SafeMediaSummary['downloadState'] | null;
  representative_path: string | null;
  representative_width: number | null;
  representative_height: number | null;
  representative_copy_requested_at: string | null;
  representative_copy_request_count: number;
};

type DetailJobRow = JobListRow & {
  poyo_task_id: string | null;
  guided_request_json: string;
  submission_state: string | null;
  estimate_json: string | null;
};

type InputRow = {
  role: string;
  input_order: number;
  media_kind: 'image' | 'video';
  source_url: string | null;
  upload_url: string | null;
  metadata_json: string;
  availability: string;
  managed_source_id: string | null;
  managed_source_name: string | null;
  managed_source_bytes: number | null;
  managed_source_checksum: string | null;
  managed_source_mime: string | null;
  managed_source_availability: 'available' | 'missing' | 'deleted' | null;
};

type OutputRow = {
  id: string;
  output_order: number;
  media_kind: 'image' | 'video';
  remote_url: string | null;
  remote_expires_at: string | null;
  remote_metadata_json: string | null;
  local_path: string | null;
  content_type: string | null;
  byte_size: number | null;
  checksum: string | null;
  signature: string | null;
  aspect_ratio: string | null;
  pixel_width: number | null;
  pixel_height: number | null;
  download_state: SafeMediaSummary['downloadState'];
  favorite: number;
  pinned: number;
  verified_at: string | null;
  deleted_at: string | null;
  download_copy_requested_at: string | null;
  download_copy_request_count: number;
};

type AttemptRow = {
  output_id: string;
  attempt: number;
  status: DownloadAttemptDto['status'];
  bytes_received: number;
  safe_error_json: string | null;
  started_at: string;
  completed_at: string | null;
};

type HistoryRow = {
  event_id: number;
  event_type: string;
  local_phase: string;
  remote_status_raw: string | null;
  remote_status: string;
  failure_domain: string;
  progress: number | null;
  safe_payload_json: string | null;
  observed_at: string;
};

type Cursor = { createdAt: string; id: string };
type NeighborCandidateRow = {
  id: string;
  entry_key: string | null;
  workflow: string;
  public_model_id: string;
  created_at: string;
};

const allModels = modelCatalogue();
const modelByKey = new Map(allModels.map((entry) => [entry.key, entry]));

function resolveModel(entryKey: string | null, publicModelId: string, workflow: string) {
  return (
    (entryKey ? modelByKey.get(entryKey) : undefined) ??
    allModels.find(
      (entry) => entry.publicModelId === publicModelId && entry.workflow === workflow
    ) ??
    allModels.find((entry) => entry.publicModelId === publicModelId)
  );
}

function encodeCursor(row: { created_at: string; id: string }): string {
  return btoa(JSON.stringify({ createdAt: row.created_at, id: row.id } satisfies Cursor));
}

export function decodePageCursor(value: string): Cursor | null {
  if (!value || value.length > 512) return null;
  try {
    const parsed = JSON.parse(atob(value)) as Partial<Cursor>;
    if (
      typeof parsed.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== 'string' ||
      parsed.id.length < 8 ||
      parsed.id.length > 128
    )
      return null;
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}
function encodeActivityCursor(row: ActivityRow): string {
  return btoa(
    JSON.stringify({
      occurredAt: row.occurred_at,
      kindOrdinal: row.kind_ordinal,
      tieId: row.tie_id
    } satisfies ActivityCursor)
  );
}

function isCanonicalActivityTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function decodeActivityCursor(value: string): ActivityCursor | null {
  if (!value || value.length > 512) return null;
  try {
    const parsed = JSON.parse(atob(value)) as Partial<ActivityCursor>;
    if (
      !isCanonicalActivityTimestamp(parsed.occurredAt) ||
      (parsed.kindOrdinal !== 1 && parsed.kindOrdinal !== 0) ||
      typeof parsed.tieId !== 'string' ||
      parsed.tieId.length < 8 ||
      parsed.tieId.length > 128
    )
      return null;
    return {
      occurredAt: parsed.occurredAt,
      kindOrdinal: parsed.kindOrdinal,
      tieId: parsed.tieId
    };
  } catch {
    return null;
  }
}

function like(value: string): string {
  return `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

function addDateFilters(
  alias: string,
  dateFrom: string,
  dateTo: string,
  clauses: string[],
  bindings: Binding[]
): void {
  if (dateFrom) {
    clauses.push(`${alias}.created_at>=?`);
    bindings.push(`${dateFrom}T00:00:00.000Z`);
  }
  if (dateTo) {
    const exclusive = new Date(`${dateTo}T00:00:00.000Z`);
    exclusive.setUTCDate(exclusive.getUTCDate() + 1);
    clauses.push(`${alias}.created_at<?`);
    bindings.push(exclusive.toISOString());
  }
}

function addCursor(alias: string, value: string, clauses: string[], bindings: Binding[]): void {
  const cursor = decodePageCursor(value);
  if (!cursor) return;
  clauses.push(`(${alias}.created_at<? OR (${alias}.created_at=? AND ${alias}.id<?))`);
  bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
}
function addActivityFilters(
  filters: Omit<JobFiltersDto, 'cursor'>,
  occurredAt: string,
  clauses: string[],
  bindings: Binding[]
): void {
  const states: Record<Exclude<JobFiltersDto['status'], 'all'>, string> = {
    queued:
      "j.local_phase IN ('queued','validating','uploading','submission_prepared','submitting')",
    running: "j.local_phase IN ('monitoring','downloading') AND j.remote_status!='failed'",
    completed: "j.local_phase='complete' AND j.remote_status!='failed'",
    failed: "j.remote_status='failed'",
    attention: "j.local_phase='requires_attention'",
    stale: "j.attention_code='stale'"
  };
  if (filters.status !== 'all') clauses.push(states[filters.status]);
  if (filters.q) {
    const search = like(filters.q);
    clauses.push("(j.search_text LIKE ? ESCAPE '\\' OR j.public_model_id LIKE ? ESCAPE '\\')");
    bindings.push(search, search);
  }
  if (filters.model) {
    clauses.push('j.public_model_id=?');
    bindings.push(filters.model);
  }
  if (filters.workflow) {
    clauses.push('j.workflow=?');
    bindings.push(filters.workflow);
  }
  if (filters.dateFrom) {
    clauses.push(`${occurredAt}>=?`);
    bindings.push(`${filters.dateFrom}T00:00:00.000Z`);
  }
  if (filters.dateTo) {
    const exclusive = new Date(`${filters.dateTo}T00:00:00.000Z`);
    exclusive.setUTCDate(exclusive.getUTCDate() + 1);
    clauses.push(`${occurredAt}<?`);
    bindings.push(exclusive.toISOString());
  }
}

function modelIdsForProvider(provider: string): string[] {
  return [
    ...new Set(
      allModels.filter((entry) => entry.provider === provider).map((entry) => entry.publicModelId)
    )
  ];
}
function addLibraryFilters(
  filters: Omit<LibraryFiltersDto, 'cursor' | 'view'>,
  clauses: string[],
  bindings: ViewerSequenceQueryBinding[]
): void {
  clauses.push('EXISTS(SELECT 1 FROM job_outputs o WHERE o.job_id=j.id)');
  if (filters.q) {
    const search = like(filters.q);
    clauses.push(
      `(j.search_text LIKE ? ESCAPE '\\' OR j.public_model_id LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM job_outputs oq WHERE oq.job_id=j.id AND oq.local_path LIKE ? ESCAPE '\\') OR EXISTS(SELECT 1 FROM job_tags jt JOIN tags t ON t.id=jt.tag_id WHERE jt.job_id=j.id AND t.display_name LIKE ? ESCAPE '\\'))`
    );
    bindings.push(search, search, search, search);
  }
  if (filters.mediaKind) {
    clauses.push('EXISTS(SELECT 1 FROM job_outputs ok WHERE ok.job_id=j.id AND ok.media_kind=?)');
    bindings.push(filters.mediaKind);
  }
  if (filters.model) {
    clauses.push('j.public_model_id=?');
    bindings.push(filters.model);
  }
  if (filters.provider) {
    const ids = modelIdsForProvider(filters.provider);
    if (!ids.length) clauses.push('0=1');
    else {
      clauses.push(`j.public_model_id IN (${ids.map(() => '?').join(',')})`);
      bindings.push(...ids);
    }
  }
  if (filters.workflow) {
    clauses.push('j.workflow=?');
    bindings.push(filters.workflow);
  }
  if (filters.aspectRatio) {
    clauses.push(
      "COALESCE(json_extract(j.guided_request_json,'$.aspectRatio'),json_extract(j.guided_request_json,'$.size'))=?"
    );
    bindings.push(filters.aspectRatio);
  }
  if (filters.favorite)
    clauses.push(
      'EXISTS(SELECT 1 FROM job_outputs ofav WHERE ofav.job_id=j.id AND ofav.favorite=1)'
    );
  if (filters.tag) {
    clauses.push(
      'EXISTS(SELECT 1 FROM job_tags jt JOIN tags t ON t.id=jt.tag_id WHERE jt.job_id=j.id AND t.normalized_name=?)'
    );
    bindings.push(filters.tag.toLocaleLowerCase());
  }
  const statusClauses: Record<Exclude<LibraryFiltersDto['status'], 'all'>, string> = {
    available:
      "EXISTS(SELECT 1 FROM job_outputs os WHERE os.job_id=j.id AND os.download_state='verified' AND os.local_path IS NOT NULL)",
    attention:
      "(j.local_phase='requires_attention' OR EXISTS(SELECT 1 FROM job_outputs os WHERE os.job_id=j.id AND os.download_state IN ('failed','expired')))",
    'remote-only':
      "NOT EXISTS(SELECT 1 FROM job_outputs os WHERE os.job_id=j.id AND os.download_state='verified') AND EXISTS(SELECT 1 FROM job_outputs os WHERE os.job_id=j.id AND os.remote_url IS NOT NULL)",
    deleted:
      "NOT EXISTS(SELECT 1 FROM job_outputs os WHERE os.job_id=j.id AND os.download_state!='deleted')"
  };
  if (filters.status !== 'all') clauses.push(statusClauses[filters.status]);
  addDateFilters('j', filters.dateFrom, filters.dateTo, clauses, bindings);
}

function viewerFilterSignature(filters: Omit<LibraryFiltersDto, 'cursor' | 'view'>): string {
  return JSON.stringify(filters);
}

function signViewerToken(payload: string, context: ViewerSequenceTokenContext): string {
  return createHmac('sha256', context.secret).update(payload).digest('base64url');
}

function encodeViewerToken(
  payload: Record<string, unknown>,
  context: ViewerSequenceTokenContext
): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${signViewerToken(encoded, context)}`;
}

function decodeViewerToken(
  value: string,
  context: ViewerSequenceTokenContext
): Record<string, unknown> | null {
  const [encoded, signature, extra] = value.split('.');
  if (!encoded || !signature || extra || value.length > 1024) return null;
  const expected = signViewerToken(encoded, context);
  const actual = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actual.length !== expectedBytes.length || !timingSafeEqual(actual, expectedBytes))
    return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function mediaSummary(row: {
  representative_id: string | null;
  representative_kind: 'image' | 'video' | null;
  representative_type: string | null;
  representative_state: SafeMediaSummary['downloadState'] | null;
  representative_path: string | null;
  representative_width: number | null;
  representative_height: number | null;
  representative_copy_requested_at: string | null;
  representative_copy_request_count: number;
}): SafeMediaSummary | null {
  if (!row.representative_id || !row.representative_kind || !row.representative_state) return null;
  return {
    outputId: row.representative_id,
    mediaKind: row.representative_kind,
    contentType: row.representative_type,
    fileName: row.representative_path ? basename(row.representative_path) : null,
    pixelWidth: row.representative_width,
    pixelHeight: row.representative_height,
    downloadState: row.representative_state,
    mediaUrl:
      row.representative_state === 'verified'
        ? `/api/media/${encodeURIComponent(row.representative_id)}`
        : null,
    downloadCopyRequestedAt: row.representative_copy_requested_at,
    downloadCopyRequestCount: row.representative_copy_request_count
  };
}

function jobDto(row: JobListRow): JobListItemDto {
  const model = resolveModel(row.entry_key, row.public_model_id, row.workflow);
  const ipGuardReason = publicIpv4GuardReason(row.attention_code);
  return {
    id: row.id,
    entryKey: row.entry_key,
    displayName: model?.displayName ?? row.public_model_id,
    provider: model?.provider ?? 'Unknown provider',
    modality: model?.modality ?? row.representative_kind ?? 'image',
    workflow: row.workflow,
    publicModelId: row.public_model_id,
    localPhase: row.local_phase,
    remoteStatus: row.remote_status,
    failureDomain: row.failure_domain,
    attentionCode: ipGuardReason ? 'ip_guard_blocked' : row.attention_code,
    ipGuardReason,
    progress: row.progress,
    estimatedCredits: row.estimated_credits,
    actualCredits: row.actual_credits,
    lastPolledAt: row.last_polled_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    promptExcerpt: row.prompt_text?.slice(0, 220) ?? null,
    outputCount: row.output_count,
    verifiedOutputCount: row.verified_count,
    outputState: row.output_state,
    representative: mediaSummary(row)
  };
}
function activityCost(row: ActivityRow): Extract<JobActivityDto, { kind: 'job-created' }>['cost'] {
  const charge = taskChargeFromParts({
    credits: row.actual_credits,
    remoteStatus: row.remote_status,
    remoteStatusRaw: row.remote_status_raw,
    settledAt: row.last_polled_at
  });
  if (charge) {
    return {
      kind: 'charge',
      credits: charge.credits,
      terminalStatus: charge.terminalStatus,
      settledAt: charge.settledAt
    };
  }
  if (
    row.estimated_credits === null ||
    !Number.isFinite(row.estimated_credits) ||
    !row.estimate_json
  )
    return { kind: 'unavailable' };
  try {
    const payload = JSON.parse(row.estimate_json) as { estimate?: Record<string, unknown> };
    const estimate = payload.estimate;
    if (
      !estimate ||
      estimate.credits !== row.estimated_credits ||
      typeof estimate.signature !== 'string' ||
      !['published', 'observed', 'blend'].includes(String(estimate.provenance)) ||
      !(estimate.sourceVerifiedAt === null || isExactIsoUtcInstant(estimate.sourceVerifiedAt))
    )
      return { kind: 'unavailable' };
    return {
      kind: 'estimate',
      credits: row.estimated_credits,
      provenance: estimate.provenance as 'published' | 'observed' | 'blend',
      sourceVerifiedAt: estimate.sourceVerifiedAt as string | null
    };
  } catch {
    return { kind: 'unavailable' };
  }
}

function activityDto(row: ActivityRow): JobActivityDto {
  const job = jobDto(row);
  if (row.activity_kind === 'attachment-request') {
    return {
      kind: 'attachment-request',
      id: row.tie_id,
      occurredAt: row.occurred_at,
      job,
      fileName: row.attachment_path ? basename(row.attachment_path) : null,
      cost: null
    };
  }
  return {
    kind: 'job-created',
    id: row.tie_id,
    occurredAt: row.occurred_at,
    job,
    cost: activityCost(row)
  };
}

function representativeOutputSelect(column: string): string {
  const id = `COALESCE(
    (SELECT o.id FROM job_outputs o WHERE o.job_id=j.id AND o.favorite=1 AND o.download_state='verified' ORDER BY o.output_order LIMIT 1),
    (SELECT o.id FROM job_outputs o WHERE o.job_id=j.id AND o.favorite=1 AND o.download_state!='verified' ORDER BY o.output_order LIMIT 1),
    (SELECT o.id FROM job_outputs o WHERE o.job_id=j.id AND o.favorite=0 AND o.download_state='verified' ORDER BY o.output_order LIMIT 1),
    (SELECT o.id FROM job_outputs o WHERE o.job_id=j.id AND o.favorite=0 AND o.download_state!='verified' ORDER BY o.output_order LIMIT 1)
  )`;
  return `(SELECT o.${column} FROM job_outputs o WHERE o.id=${id})`;
}

export function viewerSequenceCanonicalRepresentativeFilter(): string {
  return `COALESCE((${representativeOutputSelect('download_state')}='verified' AND ${representativeOutputSelect('local_path')} IS NOT NULL),0)=1`;
}

export function viewerSequencePageSeekQuery(clauses: string[]): string {
  return `SELECT j.id,j.created_at,${representativeOutputSelect('id')} output_id
         FROM jobs AS j INDEXED BY idx_jobs_gallery_order
         WHERE ${clauses.join(' AND ')}
         ORDER BY j.created_at DESC,j.id DESC LIMIT ?`;
}

export function buildViewerSequenceQueryPlan(
  filters: Omit<LibraryFiltersDto, 'cursor' | 'view'>,
  cursor: string | null
): ViewerSequenceQueryPlan | null {
  const clauses: string[] = [];
  const bindings: ViewerSequenceQueryBinding[] = [];
  addLibraryFilters(filters, clauses, bindings);
  clauses.push(viewerSequenceCanonicalRepresentativeFilter());
  const countSql = `SELECT COUNT(*) count FROM jobs j WHERE ${clauses.join(' AND ')}`;
  const seekClauses = [...clauses];
  const pageSeekBindings = [...bindings];
  if (cursor) {
    const decoded = decodePageCursor(cursor);
    if (!decoded) return null;
    seekClauses.push('(j.created_at,j.id)< (?,?)');
    pageSeekBindings.push(decoded.createdAt, decoded.id);
  }
  return {
    countSql,
    countBindings: bindings,
    pageSeekSql: viewerSequencePageSeekQuery(seekClauses),
    pageSeekBindings
  };
}

function viewerSequencePageHydrateQuery(ids: string[]): string {
  return `SELECT j.id,j.entry_key,j.workflow,j.public_model_id,j.prompt_text,j.created_at,o.id output_id,o.media_kind,
           (SELECT MAX(ar.requested_at) FROM attachment_requests ar WHERE ar.job_output_id=o.id) download_copy_requested_at,
           (SELECT COUNT(*) FROM attachment_requests ar WHERE ar.job_output_id=o.id) download_copy_request_count
         FROM jobs j JOIN job_outputs o ON o.id=${representativeOutputSelect('id')}
         WHERE j.id IN (${ids.map(() => '?').join(',')})`;
}

function listSelect(): string {
  return `j.id,j.entry_key,j.workflow,j.public_model_id,j.local_phase,j.remote_status,j.remote_status_raw,j.failure_domain,j.attention_code,j.progress,j.estimated_credits,j.actual_credits,j.prompt_text,j.last_polled_at,j.created_at,j.started_at,j.updated_at,j.completed_at,
    (SELECT COUNT(*) FROM job_outputs o WHERE o.job_id=j.id) output_count,
    (SELECT COUNT(*) FROM job_outputs o WHERE o.job_id=j.id AND o.download_state='verified') verified_count,
    (SELECT CASE WHEN COUNT(*)=0 THEN NULL WHEN SUM(o.download_state='verified')=COUNT(*) THEN 'verified' WHEN SUM(o.download_state IN ('failed','expired'))>0 THEN 'attention' WHEN SUM(o.download_state='downloading')>0 THEN 'downloading' ELSE 'pending' END FROM job_outputs o WHERE o.job_id=j.id) output_state,
    ${representativeOutputSelect('id')} representative_id,
    ${representativeOutputSelect('media_kind')} representative_kind,
    ${representativeOutputSelect('content_type')} representative_type,
    ${representativeOutputSelect('download_state')} representative_state,
    ${representativeOutputSelect('local_path')} representative_path,
    ${representativeOutputSelect('pixel_width')} representative_width,
    ${representativeOutputSelect('pixel_height')} representative_height,
    (SELECT MAX(ar.requested_at) FROM attachment_requests ar WHERE ar.job_output_id=${representativeOutputSelect('id')}) representative_copy_requested_at,
    (SELECT COUNT(*) FROM attachment_requests ar WHERE ar.job_output_id=${representativeOutputSelect('id')}) representative_copy_request_count`;
}

function tagArray(source: string): string[] {
  try {
    const parsed = JSON.parse(source) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

const aspectRatioValue = /^[1-9][0-9]{0,3}:[1-9][0-9]{0,3}$/;
const dimensionValue = /^[1-9][0-9]{1,4}[xX][1-9][0-9]{1,4}$/;
const namedSizeValues = new Set(['SD', 'HD', 'FHD', 'QHD', 'UHD', '1K', '2K', '4K', '8K']);

type ConfigurationRule = {
  key: SafeConfigurationFieldDto['key'];
  label: string;
  project: (value: unknown) => string | null;
};

function finiteNumber(value: unknown, minimum: number, maximum: number): string | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    !Object.is(value, -0) &&
    value >= minimum &&
    value <= maximum
    ? String(value)
    : null;
}

function integer(value: unknown, minimum: number, maximum: number): string | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    value >= minimum &&
    value <= maximum
    ? String(value)
    : null;
}

const configurationRules: readonly ConfigurationRule[] = [
  {
    key: 'aspectRatio',
    label: 'Aspect ratio',
    project: (value) => (typeof value === 'string' && aspectRatioValue.test(value) ? value : null)
  },
  {
    key: 'size',
    label: 'Size',
    project: (value) =>
      typeof value === 'string' && (dimensionValue.test(value) || namedSizeValues.has(value))
        ? value
        : null
  },
  {
    key: 'resolution',
    label: 'Resolution',
    project: (value) =>
      typeof value === 'string' && (dimensionValue.test(value) || namedSizeValues.has(value))
        ? value
        : null
  },
  { key: 'width', label: 'Width', project: (value) => integer(value, 1, 32768) },
  { key: 'height', label: 'Height', project: (value) => integer(value, 1, 32768) },
  { key: 'duration', label: 'Duration', project: (value) => finiteNumber(value, 0.1, 3600) },
  { key: 'fps', label: 'FPS', project: (value) => finiteNumber(value, 1, 240) },
  { key: 'frames', label: 'Frames', project: (value) => integer(value, 1, 1_000_000) },
  { key: 'seed', label: 'Seed', project: (value) => integer(value, 0, 4_294_967_295) },
  { key: 'steps', label: 'Steps', project: (value) => integer(value, 1, 1000) },
  {
    key: 'guidanceScale',
    label: 'Guidance scale',
    project: (value) => finiteNumber(value, 0, 100)
  },
  {
    key: 'promptStrength',
    label: 'Prompt strength',
    project: (value) => finiteNumber(value, 0, 1)
  },
  { key: 'outputCount', label: 'Output count', project: (value) => integer(value, 1, 100) }
];

export function projectSafeConfiguration(source: unknown): SafeConfigurationFieldDto[] {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return [];
  const fields: SafeConfigurationFieldDto[] = [];
  for (const rule of configurationRules) {
    const descriptor = Object.getOwnPropertyDescriptor(source, rule.key);
    if (!descriptor || !('value' in descriptor)) continue;
    const value = rule.project(descriptor.value);
    if (value !== null) fields.push({ key: rule.key, label: rule.label, value });
  }
  return fields;
}

function requestedAspectRatio(fields: SafeConfigurationFieldDto[]): string | null {
  const ratio = fields.find((field) => field.key === 'aspectRatio');
  if (ratio) return ratio.value;
  const size = fields.find((field) => field.key === 'size' && dimensionValue.test(field.value));
  if (!size) return null;
  const [width, height] = size.value.toLowerCase().split('x');
  return width && height ? `${width}:${height}` : null;
}

export class LibraryRepository extends DatabaseRepository {
  constructor(
    database: Database,
    private readonly now: () => Date = () => new Date()
  ) {
    super(database);
  }

  listJobs(filters: JobFiltersDto, limit = 40): CursorPage<JobListItemDto> {
    const clauses = ['1=1'];
    const bindings: Binding[] = [];
    const states: Record<Exclude<JobFiltersDto['status'], 'all'>, string> = {
      queued:
        "j.local_phase IN ('queued','validating','uploading','submission_prepared','submitting')",
      running: "j.local_phase IN ('monitoring','downloading') AND j.remote_status!='failed'",
      completed: "j.local_phase='complete' AND j.remote_status!='failed'",
      failed: "j.remote_status='failed'",
      attention: "j.local_phase='requires_attention'",
      stale: "j.attention_code='stale'"
    };
    if (filters.status !== 'all') clauses.push(states[filters.status]);
    if (filters.q) {
      clauses.push("(j.search_text LIKE ? ESCAPE '\\' OR j.public_model_id LIKE ? ESCAPE '\\')");
      bindings.push(like(filters.q), like(filters.q));
    }
    if (filters.model) {
      clauses.push('j.public_model_id=?');
      bindings.push(filters.model);
    }
    if (filters.workflow) {
      clauses.push('j.workflow=?');
      bindings.push(filters.workflow);
    }
    addDateFilters('j', filters.dateFrom, filters.dateTo, clauses, bindings);
    const countBindings = [...bindings];
    addCursor('j', filters.cursor, clauses, bindings);
    const sql = `SELECT ${listSelect()} FROM jobs j WHERE ${clauses.join(' AND ')} ORDER BY j.created_at DESC,j.id DESC LIMIT ?`;
    const rows = this.database
      .query<JobListRow, Binding[]>(sql)
      .all(...bindings, Math.min(100, Math.max(1, limit)) + 1);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const lastItem = items.at(-1);
    const countClauses = clauses.filter((clause) => !clause.includes('j.created_at<? OR'));
    const total =
      this.database
        .query<{ count: number }, Binding[]>(
          `SELECT COUNT(*) count FROM jobs j WHERE ${countClauses.join(' AND ')}`
        )
        .get(...countBindings)?.count ?? 0;
    return {
      items: items.map(jobDto),
      nextCursor: hasMore && lastItem ? encodeCursor(lastItem) : null,
      total
    };
  }
  listActivities(filters: JobFiltersDto, limit = 40): CursorPage<JobActivityDto> {
    const jobClauses = ['1=1'];
    const attachmentClauses = ['1=1'];
    const jobBindings: Binding[] = [];
    const attachmentBindings: Binding[] = [];
    addActivityFilters(filters, 'j.created_at', jobClauses, jobBindings);
    addActivityFilters(filters, 'ar.requested_at', attachmentClauses, attachmentBindings);

    const jobSelect = `SELECT 'job-created' activity_kind,j.created_at occurred_at,1 kind_ordinal,
      j.id tie_id,NULL attachment_path,
      (SELECT e.safe_payload_json FROM job_events e WHERE e.job_id=j.id AND e.event_type='job.created' ORDER BY e.event_id LIMIT 1) estimate_json,
      ${listSelect()} FROM jobs j WHERE ${jobClauses.join(' AND ')}`;
    const attachmentSelect = `SELECT 'attachment-request' activity_kind,ar.requested_at occurred_at,0 kind_ordinal,
      ar.id tie_id,o.local_path attachment_path,NULL estimate_json,
      ${listSelect()} FROM attachment_requests ar
      JOIN job_outputs o ON o.id=ar.job_output_id
      JOIN jobs j ON j.id=o.job_id
      WHERE ${attachmentClauses.join(' AND ')}`;
    const activities = `${jobSelect} UNION ALL ${attachmentSelect}`;
    const countBindings = [...jobBindings, ...attachmentBindings];
    const cursor = decodeActivityCursor(filters.cursor);
    const pageBindings = [...countBindings];
    const cursorClause = cursor
      ? 'WHERE (occurred_at<? OR (occurred_at=? AND (kind_ordinal<? OR (kind_ordinal=? AND tie_id<?))))'
      : '';
    if (cursor)
      pageBindings.push(
        cursor.occurredAt,
        cursor.occurredAt,
        cursor.kindOrdinal,
        cursor.kindOrdinal,
        cursor.tieId
      );
    const cappedLimit = Math.min(100, Math.max(1, limit));
    const rows = this.database
      .query<ActivityRow, Binding[]>(
        `WITH activities AS (${activities})
         SELECT * FROM activities ${cursorClause}
         ORDER BY occurred_at DESC,kind_ordinal DESC,tie_id DESC LIMIT ?`
      )
      .all(...pageBindings, cappedLimit + 1);
    const pageRows = rows.slice(0, cappedLimit);
    const lastRow = pageRows.at(-1);
    const total =
      this.database
        .query<{ count: number }, Binding[]>(`SELECT COUNT(*) count FROM (${activities})`)
        .get(...countBindings)?.count ?? 0;
    return {
      items: pageRows.map(activityDto),
      nextCursor: rows.length > cappedLimit && lastRow ? encodeActivityCursor(lastRow) : null,
      total
    };
  }

  listLibrary(filters: LibraryFiltersDto, limit = 24): CursorPage<LibraryGroupDto> {
    const clauses: string[] = [];
    const bindings: Binding[] = [];
    addLibraryFilters(filters, clauses, bindings);
    const countBindings = [...bindings];
    addCursor('j', filters.cursor, clauses, bindings);
    const sql = `SELECT j.id,j.entry_key,j.workflow,j.public_model_id,j.prompt_text,j.created_at,j.completed_at,j.attention_code,
      (SELECT COUNT(*) FROM job_outputs o WHERE o.job_id=j.id) output_count,
      (SELECT COUNT(*) FROM job_outputs o WHERE o.job_id=j.id AND o.download_state='verified') verified_count,
      COALESCE((SELECT SUM(COALESCE(o.byte_size,0)) FROM job_outputs o WHERE o.job_id=j.id AND o.download_state='verified'),0) total_bytes,
      COALESCE((SELECT MAX(o.favorite) FROM job_outputs o WHERE o.job_id=j.id),0) favorite,
      COALESCE((SELECT MAX(o.pinned) FROM job_outputs o WHERE o.job_id=j.id),0) pinned,
      COALESCE(json_extract(j.guided_request_json,'$.aspectRatio'),json_extract(j.guided_request_json,'$.size')) aspect_ratio,
      (SELECT CASE WHEN SUM(o.download_state IN ('failed','expired'))>0 THEN 'Download needs attention' WHEN SUM(o.download_state='deleted')>0 THEN 'A local file was removed' WHEN SUM(o.download_state!='verified')>0 THEN 'Some outputs are not available locally' ELSE NULL END FROM job_outputs o WHERE o.job_id=j.id) warning,
      COALESCE((SELECT json_group_array(display_name) FROM (SELECT t.display_name FROM job_tags jt JOIN tags t ON t.id=jt.tag_id WHERE jt.job_id=j.id ORDER BY t.display_name)),'[]') tags_json,
      ${representativeOutputSelect('id')} representative_id,
      ${representativeOutputSelect('media_kind')} representative_kind,
      ${representativeOutputSelect('content_type')} representative_type,
      ${representativeOutputSelect('download_state')} representative_state,
      ${representativeOutputSelect('local_path')} representative_path,
      ${representativeOutputSelect('pixel_width')} representative_width,
      ${representativeOutputSelect('pixel_height')} representative_height,
      (SELECT MAX(ar.requested_at) FROM attachment_requests ar WHERE ar.job_output_id=${representativeOutputSelect('id')}) representative_copy_requested_at,
      (SELECT COUNT(*) FROM attachment_requests ar WHERE ar.job_output_id=${representativeOutputSelect('id')}) representative_copy_request_count
      FROM jobs j WHERE ${clauses.join(' AND ')} ORDER BY j.created_at DESC,j.id DESC LIMIT ?`;
    const rows = this.database
      .query<LibraryRow, Binding[]>(sql)
      .all(...bindings, Math.min(60, Math.max(1, limit)) + 1);
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const lastPageRow = pageRows.at(-1);
    const countClauses = clauses.filter((clause) => !clause.includes('j.created_at<? OR'));
    const total =
      this.database
        .query<{ count: number }, Binding[]>(
          `SELECT COUNT(*) count FROM jobs j WHERE ${countClauses.join(' AND ')}`
        )
        .get(...countBindings)?.count ?? 0;
    return {
      items: pageRows.map((row) => {
        const model = resolveModel(row.entry_key, row.public_model_id, row.workflow);
        const ipGuardReason = publicIpv4GuardReason(row.attention_code);
        return {
          jobId: row.id,
          entryKey: row.entry_key,
          displayName: model?.displayName ?? row.public_model_id,
          provider: model?.provider ?? 'Unknown provider',
          modality: model?.modality ?? row.representative_kind ?? 'image',
          workflow: row.workflow,
          publicModelId: row.public_model_id,
          promptExcerpt: row.prompt_text?.slice(0, 220) ?? null,
          createdAt: row.created_at,
          completedAt: row.completed_at,
          outputCount: row.output_count,
          verifiedOutputCount: row.verified_count,
          totalBytes: row.total_bytes,
          favorite: row.favorite === 1,
          pinned: row.pinned === 1,
          aspectRatio: row.aspect_ratio,
          warning:
            ipGuardReason === 'match'
              ? 'Blocked by IP guard'
              : ipGuardReason === 'unavailable'
                ? 'IP check unavailable'
                : ipGuardReason === 'misconfigured'
                  ? 'IP guard settings invalid'
                  : row.warning,
          tags: tagArray(row.tags_json),
          representative: mediaSummary(row)
        } satisfies LibraryGroupDto;
      }),
      nextCursor: hasMore && lastPageRow ? encodeCursor(lastPageRow) : null,
      total
    };
  }
  listViewerSequence(
    filters: Omit<LibraryFiltersDto, 'cursor' | 'view'>,
    cursor: string | null,
    snapshot: string | null,
    limit: number,
    tokenContext: ViewerSequenceTokenContext,
    queryObserver: ViewerSequenceQueryObserver = () => {}
  ): GalleryViewerSequencePageDto {
    return this.database.transaction(() => {
      const pageSize = Math.min(200, Math.max(1, limit));
      let phase: 'initial' | 'intermediate' | 'terminal' = snapshot ? 'intermediate' : 'initial';
      const queryPlan = buildViewerSequenceQueryPlan(filters, cursor);
      if (!queryPlan) throw new ViewerSequenceChangedError();
      const filterSignature = viewerFilterSignature(filters);
      const marker = () => {
        const changes =
          this.database.query<{ value: number }, []>('SELECT total_changes() value').get()?.value ??
          0;
        const version =
          this.database.query<{ data_version: number }, []>('PRAGMA data_version').get()
            ?.data_version ?? 0;
        const value = `${changes}:${version}`;
        queryObserver({ phase, operation: 'marker', bindings: 0, rows: 1, diagnostics: [value] });
        return value;
      };
      const count = () => {
        const value =
          this.database
            .query<{ count: number }, ViewerSequenceQueryBinding[]>(queryPlan.countSql)
            .get(...queryPlan.countBindings)?.count ?? 0;
        queryObserver({
          phase,
          operation: 'count',
          bindings: queryPlan.countBindings.length,
          rows: 1,
          diagnostics: [String(value)]
        });
        return value;
      };

      let initialTotal: number;
      let initialMarker: string;
      if (snapshot) {
        const token = decodeViewerToken(snapshot, tokenContext);
        if (
          token?.v !== 1 ||
          token.n !== tokenContext.nonce ||
          token.f !== filterSignature ||
          token.p !== pageSize ||
          typeof token.t !== 'number' ||
          !Number.isSafeInteger(token.t) ||
          typeof token.m !== 'string' ||
          !cursor ||
          !decodePageCursor(cursor)
        ) {
          throw new ViewerSequenceChangedError();
        }
        initialTotal = token.t;
        initialMarker = token.m;
        if (marker() !== initialMarker) throw new ViewerSequenceChangedError();
      } else {
        if (cursor) throw new ViewerSequenceChangedError();
        initialMarker = marker();
        initialTotal = count();
      }

      const keyRows = this.database
        .query<{ id: string; created_at: string; output_id: string }, ViewerSequenceQueryBinding[]>(
          queryPlan.pageSeekSql
        )
        .all(...queryPlan.pageSeekBindings, pageSize + 1);
      queryObserver({
        phase,
        operation: 'page-seek',
        bindings: queryPlan.pageSeekBindings.length + 1,
        rows: keyRows.length
      });
      const hasMore = keyRows.length > pageSize;
      const selected = keyRows.slice(0, pageSize);
      if (
        selected.some((row) => !row.output_id) ||
        new Set(selected.map((row) => row.id)).size !== selected.length
      )
        throw new ViewerSequenceChangedError();

      const ids = selected.map((row) => row.id);
      const hydrated =
        ids.length === 0
          ? []
          : this.database
              .query<
                {
                  id: string;
                  entry_key: string | null;
                  workflow: string;
                  public_model_id: string;
                  prompt_text: string | null;
                  created_at: string;
                  output_id: string;
                  media_kind: 'image' | 'video';
                  download_copy_requested_at: string | null;
                  download_copy_request_count: number;
                },
                string[]
              >(viewerSequencePageHydrateQuery(ids))
              .all(...ids);
      queryObserver({
        phase,
        operation: 'page-hydrate',
        bindings: ids.length,
        rows: hydrated.length
      });
      if (hydrated.length !== selected.length) throw new ViewerSequenceChangedError();
      const hydratedById = new Map(hydrated.map((row) => [row.id, row]));
      const items = selected.map((key) => {
        const row = hydratedById.get(key.id);
        if (!row || row.output_id !== key.output_id) throw new ViewerSequenceChangedError();
        const model = resolveModel(row.entry_key, row.public_model_id, row.workflow);
        return {
          jobId: row.id,
          displayName: model?.displayName ?? row.public_model_id,
          provider: model?.provider ?? 'Unknown provider',
          workflow: row.workflow,
          promptExcerpt: row.prompt_text?.slice(0, 220) ?? null,
          createdAt: row.created_at,
          outputId: row.output_id,
          mediaKind: row.media_kind,
          mediaUrl: `/api/media/${encodeURIComponent(row.output_id)}`,
          downloadCopyRequestedAt: row.download_copy_requested_at,
          downloadCopyRequestCount: row.download_copy_request_count
        } satisfies GalleryViewerItemDto;
      });
      const terminal = !hasMore;
      if (terminal && snapshot) phase = 'terminal';
      const total = terminal && snapshot ? count() : snapshot ? null : initialTotal;
      if (terminal && snapshot && total !== initialTotal) throw new ViewerSequenceChangedError();
      if (marker() !== initialMarker) throw new ViewerSequenceChangedError();
      const lastSelected = selected.at(-1);
      const nextCursor = hasMore && lastSelected ? encodeCursor(lastSelected) : null;
      return {
        items,
        nextCursor,
        snapshot:
          snapshot ??
          encodeViewerToken(
            {
              v: 1,
              n: tokenContext.nonce,
              f: filterSignature,
              p: pageSize,
              t: initialTotal,
              m: initialMarker
            },
            tokenContext
          ),
        total
      };
    })();
  }

  async getImageNavigation(id: string, mediaRoot: string): Promise<ImageJobNavigationDto | null> {
    const current = this.database
      .query<{ id: string; created_at: string }, [string]>(
        'SELECT id,created_at FROM jobs WHERE id=?'
      )
      .get(id);
    if (!current) return null;
    return {
      previous: await this.findImageNeighbor(current, 'previous', mediaRoot),
      next: await this.findImageNeighbor(current, 'next', mediaRoot)
    };
  }

  private async findImageNeighbor(
    current: { id: string; created_at: string },
    direction: 'previous' | 'next',
    mediaRoot: string
  ): Promise<JobChronologyNeighborDto | null> {
    let anchor = current;
    const chronology =
      direction === 'previous'
        ? '(j.created_at<? OR (j.created_at=? AND j.id<?))'
        : '(j.created_at>? OR (j.created_at=? AND j.id>?))';
    const order =
      direction === 'previous' ? 'j.created_at DESC,j.id DESC' : 'j.created_at ASC,j.id ASC';

    while (true) {
      const candidate = this.database
        .query<NeighborCandidateRow, [string, string, string]>(
          `SELECT j.id,j.entry_key,j.workflow,j.public_model_id,j.created_at
           FROM jobs j
           WHERE ${chronology}
             AND EXISTS(
               SELECT 1 FROM job_outputs o
               WHERE o.job_id=j.id AND o.media_kind='image'
                 AND o.download_state='verified' AND o.local_path IS NOT NULL
             )
           ORDER BY ${order}
           LIMIT 1`
        )
        .get(anchor.created_at, anchor.created_at, anchor.id);
      if (!candidate) return null;

      const outputs = this.database
        .query<{ id: string }, [string]>(
          `SELECT id FROM job_outputs
           WHERE job_id=? AND media_kind='image'
             AND download_state='verified' AND local_path IS NOT NULL
           ORDER BY output_order,id`
        )
        .all(candidate.id);
      for (const output of outputs) {
        try {
          await resolveVerifiedMediaOutput(this.database, mediaRoot, output.id);
          const model = resolveModel(
            candidate.entry_key,
            candidate.public_model_id,
            candidate.workflow
          );
          return {
            jobId: candidate.id,
            displayName: model?.displayName ?? candidate.public_model_id,
            createdAt: candidate.created_at
          };
        } catch (error) {
          if (!(error instanceof MediaOutputError)) throw error;
        }
      }
      anchor = candidate;
    }
  }
  async getJobDetail(id: string): Promise<JobDetailDto | null> {
    const row = this.database
      .query<DetailJobRow, [string]>(
        `SELECT ${listSelect()},j.poyo_task_id,j.guided_request_json,(SELECT state FROM submission_intents si WHERE si.job_id=j.id) submission_state,(SELECT e.safe_payload_json FROM job_events e WHERE e.job_id=j.id AND e.event_type='job.created' ORDER BY e.event_id LIMIT 1) estimate_json FROM jobs j WHERE j.id=?`
      )
      .get(id);
    if (!row) return null;
    const attempts = this.database
      .query<AttemptRow, [string]>(
        'SELECT da.* FROM download_attempts da JOIN job_outputs o ON o.id=da.output_id WHERE o.job_id=? ORDER BY da.output_id,da.attempt DESC'
      )
      .all(id);
    const attemptsByOutput = Map.groupBy(attempts, (item) => item.output_id);
    const outputRows = this.database
      .query<OutputRow, [string]>(
        `SELECT o.*,
           (SELECT MAX(ar.requested_at) FROM attachment_requests ar WHERE ar.job_output_id=o.id) download_copy_requested_at,
           (SELECT COUNT(*) FROM attachment_requests ar WHERE ar.job_output_id=o.id) download_copy_request_count
         FROM job_outputs o WHERE o.job_id=? ORDER BY o.output_order`
      )
      .all(id);
    const outputs: JobOutputDto[] = [];
    for (const output of outputRows) {
      const localAvailable = Boolean(
        output.local_path && (await Bun.file(output.local_path).exists())
      );
      let remoteHost: string | null = null;
      if (output.remote_url)
        try {
          remoteHost = new URL(output.remote_url).hostname;
        } catch {}
      outputs.push({
        outputId: output.id,
        outputOrder: output.output_order,
        mediaKind: output.media_kind,
        contentType: output.content_type,
        fileName: output.local_path ? basename(output.local_path) : null,
        downloadState: output.download_state,
        mediaUrl: localAvailable ? `/api/media/${encodeURIComponent(output.id)}` : null,
        downloadCopyRequestedAt: output.download_copy_requested_at,
        downloadCopyRequestCount: output.download_copy_request_count,
        remoteAvailable: Boolean(output.remote_url),
        remoteHost,
        remoteExpiresAt: output.remote_expires_at,
        byteSize: output.byte_size,
        aspectRatio: output.aspect_ratio,
        pixelWidth: output.pixel_width,
        pixelHeight: output.pixel_height,
        favorite: output.favorite === 1,
        pinned: output.pinned === 1,
        localAvailable,
        verifiedAt: output.verified_at,
        deletedAt: output.deleted_at,
        attempts: (attemptsByOutput.get(output.id) ?? []).map((attempt) => ({
          attempt: attempt.attempt,
          status: attempt.status,
          bytesReceived: attempt.bytes_received,
          startedAt: attempt.started_at,
          completedAt: attempt.completed_at
        }))
      });
    }
    const inputs: JobInputDto[] = this.database
      .query<InputRow, [string]>(
        `SELECT ji.*,ms.original_name managed_source_name,ms.byte_size managed_source_bytes,
          ms.checksum managed_source_checksum,ms.mime_type managed_source_mime,
          ms.availability managed_source_availability
         FROM job_inputs ji LEFT JOIN managed_sources ms ON ms.id=ji.managed_source_id
         WHERE ji.job_id=? ORDER BY ji.role,ji.input_order`
      )
      .all(id)
      .map((input) => ({
        role: input.role,
        inputOrder: input.input_order,
        mediaKind: input.media_kind,
        sourceKind: input.managed_source_id
          ? 'local'
          : input.source_url
            ? 'remote'
            : input.upload_url
              ? 'uploaded'
              : 'unknown',
        sourceLabel:
          input.managed_source_name ?? safeUrlLabel(input.source_url ?? input.upload_url),
        originalName: input.managed_source_name,
        neutralUploadName:
          input.managed_source_id && input.managed_source_mime
            ? neutralSourceUploadName(input.managed_source_id, input.managed_source_mime)
            : null,
        availability: input.managed_source_availability ?? input.availability,
        byteSize: input.managed_source_bytes,
        localConsequence:
          input.managed_source_availability === 'available'
            ? 'retained'
            : (input.managed_source_availability ?? 'not-managed')
      }));
    const history: JobHistoryDto[] = this.database
      .query<HistoryRow, [string]>(
        'SELECT * FROM job_events WHERE job_id=? ORDER BY event_id DESC LIMIT 500'
      )
      .all(id)
      .map((event) => ({
        eventId: event.event_id,
        eventType: event.event_type,
        localPhase: event.local_phase,
        remoteStatus: event.remote_status,
        failureDomain: event.failure_domain,
        progress: event.progress,
        observedAt: event.observed_at,
        authority: event.event_type === 'status.observed' ? 'poyo' : 'local'
      }));
    const configuration = projectSafeConfiguration(JSON.parse(row.guided_request_json));
    return {
      ...jobDto(row),
      prompt: row.prompt_text,
      poyoTaskLinked: row.poyo_task_id !== null,
      submissionState: row.submission_state,
      cost: activityCost({
        ...row,
        activity_kind: 'job-created',
        occurred_at: row.created_at,
        kind_ordinal: 1,
        tie_id: row.id,
        attachment_path: null
      }),
      configuration,
      requestedAspectRatio: requestedAspectRatio(configuration),
      inputs,
      outputs,
      history,
      tags: this.tags(id)
    };
  }

  filterOptions(): JobFilterOptionsDto {
    const present = this.database
      .query<{ public_model_id: string; workflow: string; entry_key: string | null }, []>(
        'SELECT DISTINCT public_model_id,workflow,entry_key FROM jobs ORDER BY public_model_id,workflow'
      )
      .all();
    const models: ModelFilterOption[] = present.map((row) => {
      const model = resolveModel(row.entry_key, row.public_model_id, row.workflow);
      return {
        publicModelId: row.public_model_id,
        displayName: model?.displayName ?? row.public_model_id,
        provider: model?.provider ?? 'Unknown provider',
        workflow: row.workflow,
        modality: model?.modality ?? 'image'
      };
    });
    return {
      models: models.toSorted((a, b) => a.displayName.localeCompare(b.displayName)),
      workflows: [...new Set(models.map((entry) => entry.workflow))].toSorted(),
      providers: [...new Set(models.map((entry) => entry.provider))].toSorted(),
      tags: this.database
        .query<{ display_name: string }, []>('SELECT display_name FROM tags ORDER BY display_name')
        .all()
        .map((row) => row.display_name)
    };
  }

  tags(jobId: string): string[] {
    return this.database
      .query<{ display_name: string }, [string]>(
        'SELECT t.display_name FROM job_tags jt JOIN tags t ON t.id=jt.tag_id WHERE jt.job_id=? ORDER BY t.display_name'
      )
      .all(jobId)
      .map((row) => row.display_name);
  }

  setFavorite(jobId: string, favorite: boolean): void {
    this.requireJob(jobId);
    this.database
      .query('UPDATE job_outputs SET favorite=? WHERE job_id=?')
      .run(favorite ? 1 : 0, jobId);
  }

  setPinned(jobId: string, pinned: boolean): void {
    this.requireJob(jobId);
    this.database
      .query('UPDATE job_outputs SET pinned=? WHERE job_id=?')
      .run(pinned ? 1 : 0, jobId);
  }

  replaceTags(jobId: string, values: string[]): string[] {
    this.requireJob(jobId);
    const tags = [
      ...new Map(
        values
          .map((value) => value.trim().replace(/\s+/g, ' ').slice(0, 48))
          .filter(Boolean)
          .slice(0, 20)
          .map((value) => [value.toLocaleLowerCase(), value])
      ).entries()
    ];
    this.transaction(() => {
      this.database.query('DELETE FROM job_tags WHERE job_id=?').run(jobId);
      for (const [normalized, display] of tags) {
        this.database
          .query(
            'INSERT INTO tags(normalized_name,display_name,created_at) VALUES (?,?,?) ON CONFLICT(normalized_name) DO UPDATE SET display_name=excluded.display_name'
          )
          .run(normalized, display, this.now().toISOString());
        this.database
          .query(
            'INSERT OR IGNORE INTO job_tags(job_id,tag_id) SELECT ?,id FROM tags WHERE normalized_name=?'
          )
          .run(jobId, normalized);
      }
      this.database.query('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM job_tags)').run();
    });
    return this.tags(jobId);
  }

  async deleteOutput(
    jobId: string,
    outputId: string,
    choice: LocalDeleteChoice,
    paths: Pick<AppPaths, 'media'>
  ): Promise<void> {
    this.requireJob(jobId);
    const output = this.database
      .query<{ local_path: string | null }, [string, string]>(
        'SELECT local_path FROM job_outputs WHERE id=? AND job_id=?'
      )
      .get(outputId, jobId);
    if (!output) throw new Error('Output not found.');
    if ((choice === 'file' || choice === 'both') && output.local_path) {
      let resolved: string;
      try {
        resolved = resolvePathWithin(paths.media, output.local_path);
      } catch {
        throw new Error('The output file is outside managed media storage and cannot be removed.');
      }
      await Bun.file(resolved)
        .delete()
        .catch((error) => {
          if ((error as { code?: string }).code !== 'ENOENT') throw error;
        });
    }
    const timestamp = this.now().toISOString();
    this.transaction(() => {
      if (choice === 'file')
        this.database
          .query(
            "UPDATE job_outputs SET local_path=NULL,download_state='deleted',verified_at=NULL,deleted_at=? WHERE id=? AND job_id=?"
          )
          .run(timestamp, outputId, jobId);
      else
        this.database.query('DELETE FROM job_outputs WHERE id=? AND job_id=?').run(outputId, jobId);
      this.appendEvent(jobId, `output.local_${choice}_removed`, { outputId });
    });
  }

  async storageStatistics(
    paths: Pick<AppPaths, 'media' | 'uploads'>
  ): Promise<StorageStatisticsDto> {
    await new ManagedSourceRepository(this.database, paths).reconcileAll();
    const outputs = this.database
      .query<{ indexed_bytes: number; verified: number; missing: number }, []>(
        `SELECT COALESCE(SUM(CASE WHEN download_state='verified' THEN COALESCE(byte_size,0) ELSE 0 END),0) indexed_bytes,
          COALESCE(SUM(download_state='verified'),0) verified,
          COALESCE(SUM(download_state IN ('deleted','failed','expired')),0) missing
         FROM job_outputs`
      )
      .get();
    const sources = this.database
      .query<{ indexed_bytes: number; available: number; missing: number }, []>(
        `SELECT COALESCE(SUM(CASE WHEN availability='available' THEN byte_size ELSE 0 END),0) indexed_bytes,
          COALESCE(SUM(availability='available'),0) available,
          COALESCE(SUM(availability IN ('missing','deleted')),0) missing
         FROM managed_sources`
      )
      .get();
    let capacityBytes: number | null = null;
    let freeBytes: number | null = null;
    try {
      const stats = await import('node:fs/promises').then(({ statfs }) => statfs(paths.media));
      capacityBytes = Number(stats.blocks) * Number(stats.bsize);
      freeBytes = Number(stats.bavail) * Number(stats.bsize);
    } catch {}
    return {
      indexedBytes: (outputs?.indexed_bytes ?? 0) + (sources?.indexed_bytes ?? 0),
      verifiedFiles: (outputs?.verified ?? 0) + (sources?.available ?? 0),
      missingOrDeletedFiles: (outputs?.missing ?? 0) + (sources?.missing ?? 0),
      generatedBytes: outputs?.indexed_bytes ?? 0,
      managedSourceBytes: sources?.indexed_bytes ?? 0,
      managedSourceFiles: sources?.available ?? 0,
      missingOrDeletedSources: sources?.missing ?? 0,
      capacityBytes,
      freeBytes
    };
  }

  private requireJob(id: string): void {
    if (!this.database.query<{ id: string }, [string]>('SELECT id FROM jobs WHERE id=?').get(id))
      throw new Error('Job not found.');
  }

  private appendEvent(jobId: string, eventType: string, payload: Record<string, unknown>): void {
    const job = this.database
      .query<{ attention_code: string | null }, [string]>(
        'SELECT attention_code FROM jobs WHERE id=?'
      )
      .get(jobId);
    if (!job) throw new Error('Job not found.');
    this.database
      .query(
        `INSERT INTO job_events(job_id,event_type,local_phase,remote_status_raw,remote_status,failure_domain,progress,safe_payload_json,observed_at)
         SELECT id,?,local_phase,remote_status_raw,remote_status,failure_domain,progress,?,? FROM jobs WHERE id=?`
      )
      .run(
        eventType,
        JSON.stringify(packDurableJobEventPayload(payload, job.attention_code)),
        this.now().toISOString(),
        jobId
      );
  }
}

function safeUrlLabel(value: string | null): string {
  if (!value) return 'Source metadata unavailable';
  try {
    return new URL(value).hostname.slice(0, 180);
  } catch {
    return 'Source URL unavailable';
  }
}

export function studioReuseEntry(modality: 'image' | 'video', sourceKind: 'image' | 'video') {
  const entries = modality === 'image' ? IMAGE_REGISTRY_ENTRIES : VIDEO_REGISTRY_ENTRIES;
  const preferredWorkflows =
    modality === 'image'
      ? ['image-edit', 'image-to-image']
      : sourceKind === 'image'
        ? ['image-to-video', 'frame-to-video', 'reference-to-video']
        : ['video-to-video', 'video-edit'];
  return entries.find(
    (entry) =>
      entry.status === 'current' &&
      preferredWorkflows.includes(entry.workflow) &&
      entry.inputRoles.some((role) => role.mediaKind === sourceKind)
  );
}
