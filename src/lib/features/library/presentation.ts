import type { JobFilterStatus, JobFiltersDto, LibraryFiltersDto, LibraryStatus } from './contracts';

const jobStatuses = new Set<JobFilterStatus>([
  'all',
  'queued',
  'running',
  'completed',
  'failed',
  'attention',
  'stale',
  'stopped'
]);
const libraryStatuses = new Set<LibraryStatus>([
  'all',
  'available',
  'attention',
  'remote-only',
  'deleted'
]);

function bounded(value: string | null, max: number): string {
  return (value ?? '').trim().slice(0, max);
}

function date(value: string | null): string {
  const candidate = bounded(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : '';
}

export function parseJobFilters(search: URLSearchParams): JobFiltersDto {
  const candidate = bounded(search.get('status'), 32) as JobFilterStatus;
  return {
    status: jobStatuses.has(candidate) ? candidate : 'all',
    q: bounded(search.get('q'), 200),
    model: bounded(search.get('model'), 200),
    workflow: bounded(search.get('workflow'), 100),
    dateFrom: date(search.get('from')),
    dateTo: date(search.get('to')),
    cursor: bounded(search.get('cursor'), 512)
  };
}

export function parseLibraryFilters(search: URLSearchParams): LibraryFiltersDto {
  const mediaKind = bounded(search.get('kind'), 16);
  const status = bounded(search.get('status'), 32) as LibraryStatus;
  return {
    q: bounded(search.get('q'), 200),
    mediaKind: mediaKind === 'image' || mediaKind === 'video' ? mediaKind : '',
    model: bounded(search.get('model'), 200),
    provider: bounded(search.get('provider'), 120),
    workflow: bounded(search.get('workflow'), 100),
    aspectRatio: bounded(search.get('aspect'), 32),
    status: libraryStatuses.has(status) ? status : 'all',
    favorite: search.get('favorite') === 'true',
    tag: bounded(search.get('tag'), 64),
    dateFrom: date(search.get('from')),
    dateTo: date(search.get('to')),
    cursor: bounded(search.get('cursor'), 512),
    view: search.get('view') === 'list' ? 'list' : 'grid'
  };
}

export function elapsedLabel(
  startedAt: string,
  completedAt: string | null,
  now = new Date()
): string {
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : now.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 'Unknown';
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function byteSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function ratioValue(value: string | null): number | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : null;
}

export function mediaFrameAspectRatio(
  width: number | null,
  height: number | null,
  requestedRatio: string | null = null
): string {
  const fallback = ratioValue(requestedRatio);
  if (
    width === null ||
    height === null ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  )
    return fallback === null
      ? '4 / 3'
      : String(Number(Math.min(16 / 9, Math.max(3 / 4, fallback)).toFixed(6)));
  const ratio = Math.min(16 / 9, Math.max(3 / 4, width / height));
  return String(Number(ratio.toFixed(6)));
}

const dateTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC'
});
const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeZone: 'UTC'
});

export function dateTimeLabel(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? dateTimeFormatter.format(date).replace(', ', ' at ')
    : 'Unknown';
}

export function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dateFormatter.format(date) : 'Unknown';
}

export function statusLabel(
  localPhase: string,
  remoteStatus: string,
  attentionCode: string | null,
  localOutcome?: string | null
): string {
  if (attentionCode === 'ip_guard_blocked') return 'Blocked by IP guard';
  if (attentionCode === 'submission_unknown') return 'Submission outcome unknown';
  if (attentionCode === 'stale') return 'Stale — status delayed';
  if (remoteStatus === 'failed') return 'Poyo generation failed';
  if (localPhase === 'requires_attention') return 'Needs attention';
  if (localPhase === 'complete')
    return remoteStatus === 'finished'
      ? 'Available locally'
      : localOutcome === 'stopped-before-dispatch'
        ? 'Stopped before dispatch'
        : 'Outcome unavailable';
  if (localPhase === 'downloading') return 'Downloading outputs';
  if (remoteStatus === 'running') return 'Generating';
  if (remoteStatus === 'not_started') return 'Queued by Poyo';
  return localPhase.replaceAll('_', ' ');
}

export function attentionDescription(
  attentionCode: string | null,
  ipGuardReason: 'match' | 'unavailable' | 'misconfigured' | null = null,
  hasRemoteTask = false
): string {
  if (attentionCode === 'ip_guard_blocked') {
    if (hasRemoteTask) {
      return 'IP guard paused monitoring. Remote processing may still continue; correct the network or Settings, then refresh status.';
    }
    if (ipGuardReason === 'unavailable') {
      return 'Poyo was not contacted because the server could not verify its public IPv4. Refresh IP status or review Settings, then create a new run.';
    }
    return ipGuardReason === 'misconfigured'
      ? 'Poyo was not contacted because the saved IP guard settings are invalid. Disable or correct the guard in Settings, then create a new run.'
      : 'Poyo was not contacted. Change networks or update the IP guard in Settings, then create a new run.';
  }
  if (attentionCode === 'submission_unknown')
    return 'The submission outcome is unknown; retrying could spend credits twice.';
  if (attentionCode === 'stale') return 'Status monitoring is delayed.';
  return attentionCode?.replaceAll('_', ' ') ?? 'Review this job.';
}

export function statusTone(
  localPhase: string,
  remoteStatus: string,
  attentionCode: string | null
): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  if (remoteStatus === 'failed') return 'danger';
  if (localPhase === 'requires_attention' || attentionCode) return 'warning';
  if (localPhase === 'complete' && remoteStatus === 'finished') return 'success';
  if (remoteStatus === 'running' || remoteStatus === 'not_started') return 'info';
  return 'neutral';
}
