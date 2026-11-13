import type {
  JobProviderDiagnostic,
  ProviderDiagnostic
} from '../../features/diagnostics/provider-diagnostic';
import { redactString } from '../diagnostics/redaction';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Keep exact machine tokens; redact free text, URLs, credentials and oversized values. */
export function safeProviderToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(value) || redactString(value) !== value)
    return '[REDACTED]';
  return value;
}

function code(value: unknown): string | number | null {
  if (typeof value === 'string' && /^\d{1,16}$/.test(value)) return value;
  return typeof value === 'number'
    ? Number.isSafeInteger(value)
      ? value
      : null
    : safeProviderToken(value);
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
