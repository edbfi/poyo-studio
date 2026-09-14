import type { StructuredLogger } from '../diagnostics/jsonl-logger';
import { safeErrorSummary } from '../diagnostics/redaction';
import { PoyoError } from './errors';
import type { PoyoMetadataLogger, PoyoRequestMetadata } from './types';

function safeFailure(error: unknown): unknown {
  return error instanceof PoyoError ? error.toSafeDto() : safeErrorSummary(error);
}

export function createPoyoMetadataLogger(logger: StructuredLogger): PoyoMetadataLogger {
  return {
    requestStarted: (metadata) => logger.info('poyo.request.started', { data: metadata }),
    requestFinished: (metadata) => logger.info('poyo.request.finished', { data: metadata }),
    requestFailed: (metadata, error) =>
      logger.warn('poyo.request.failed', { data: { ...metadata, error: safeFailure(error) } })
  };
}

export class MemoryPoyoMetadataLogger implements PoyoMetadataLogger {
  readonly events: Array<{
    phase: 'started' | 'finished' | 'failed';
    metadata: PoyoRequestMetadata;
    error?: unknown;
  }> = [];

  requestStarted(metadata: PoyoRequestMetadata): void {
    this.events.push({ phase: 'started', metadata });
  }

  requestFinished(metadata: PoyoRequestMetadata): void {
    this.events.push({ phase: 'finished', metadata });
  }

  requestFailed(metadata: PoyoRequestMetadata, error: unknown): void {
    this.events.push({ phase: 'failed', metadata, error: safeFailure(error) });
  }
}
