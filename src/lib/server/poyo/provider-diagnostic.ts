import type {
  JobProviderDiagnostic,
  ProviderDiagnostic
} from '../../features/diagnostics/provider-diagnostic';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const publicTokens = new Set([
  'unknown',
  'not_started',
  'running',
  'finished',
  'failed',
  'cancelled',
  'canceled',
  'validation_error',
  'content_moderation_error',
  'content_too_long_error',
  'file_format_error',
  'authentication_error',
  'insufficient_credits_error',
  'permission_denied_error',
  'resource_not_found_error',
  'timeout_error',
  'rate_limit_error',
  'internal_error',
  'upstream_error',
  'service_error',
  'invalid_request_error'
]);
const publicCodes = new Set([200, 400, 401, 402, 403, 404, 408, 413, 422, 429, 500, 502, 503]);

/** Unknown provider values are presence-only, even when they look like machine tokens. */
export function safeProviderToken(value: unknown): string | null {
  return typeof value === 'string' && publicTokens.has(value) ? value : null;
}

function code(value: unknown): string | number | null {
  if (typeof value === 'number') return publicCodes.has(value) ? value : null;
  if (
    typeof value === 'string' &&
    publicCodes.has(Number(value)) &&
    String(Number(value)) === value
  )
    return value;
  return safeProviderToken(value);
}

// Exact static example from Poyo's error-codes and task-management/status docs.
// This is diagnostic provenance, NOT a retry classifier or a billing guarantee.
const documentedMessage = 'The prompt violates our content policy';

export function sanitizeProviderDiagnostic(value: unknown): ProviderDiagnostic {
  const data = record(value);
  return {
    version: 1,
    httpStatus:
      typeof data.httpStatus === 'number' &&
      Number.isInteger(data.httpStatus) &&
      data.httpStatus >= 100 &&
      data.httpStatus <= 599
        ? data.httpStatus
        : null,
    responseCode: code(data.responseCode),
    errorCode: code(data.errorCode),
    errorType: safeProviderToken(data.errorType),
    statusRaw: safeProviderToken(data.statusRaw),
    responseCodePresent: data.responseCodePresent === true,
    errorCodePresent: data.errorCodePresent === true,
    errorTypePresent: data.errorTypePresent === true,
    statusPresent: data.statusPresent === true,
    errorMessagePresent: data.errorMessagePresent === true,
    documentedMessage: data.documentedMessage === documentedMessage ? documentedMessage : null
  };
}

export function providerDiagnostic(payload: unknown, httpStatus?: number): ProviderDiagnostic {
  const root = record(payload);
  const data = 'data' in root ? record(root.data) : root;
  const error = record(root.error ?? data.error);
  const message = error.message ?? data.error_message ?? root.detail;
  return sanitizeProviderDiagnostic({
    httpStatus,
    responseCode: root.code,
    errorCode: error.code ?? data.error_code,
    errorType: error.type ?? data.error_type,
    statusRaw: data.status,
    responseCodePresent: root.code != null,
    errorCodePresent: (error.code ?? data.error_code) != null,
    errorTypePresent: (error.type ?? data.error_type) != null,
    statusPresent: data.status != null,
    errorMessagePresent: message !== undefined && message !== null,
    documentedMessage: message
  });
}

export function jobProviderDiagnostic(
  value: unknown,
  source: JobProviderDiagnostic['source'],
  seedExplicit: boolean
): JobProviderDiagnostic {
  return { ...sanitizeProviderDiagnostic(value), source, seed_explicit: seedExplicit };
}

/** Validate persisted metadata again at public DTO/SSE boundaries, including legacy rows. */
export function readJobProviderDiagnostic(payload: unknown): JobProviderDiagnostic | null {
  const data = record(record(payload).providerDiagnostic);
  if (
    data.version !== 1 ||
    !['submit_error', 'submit_ack', 'status', 'poll_error'].includes(String(data.source)) ||
    typeof data.seed_explicit !== 'boolean'
  )
    return null;
  return jobProviderDiagnostic(
    data,
    data.source as JobProviderDiagnostic['source'],
    data.seed_explicit
  );
}
