export interface GenerationRetryPolicy {
  enabled: boolean;
  maxRetries: number;
}
export const DEFAULT_GENERATION_RETRIES: GenerationRetryPolicy = { enabled: false, maxRetries: 3 };
export function normalizeGenerationRetries(value: unknown): GenerationRetryPolicy {
  const data =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    enabled: data.enabled === true,
    maxRetries:
      typeof data.maxRetries === 'number' &&
      Number.isInteger(data.maxRetries) &&
      data.maxRetries >= 1 &&
      data.maxRetries <= 5
        ? data.maxRetries
        : 3
  };
}
export interface AutomaticRetry {
  rootId: string;
  parentId: string | null;
  ordinal: number;
  maxRetries: number;
  state: 'running' | 'stopped' | 'blocked' | 'exhausted' | 'succeeded' | 'needs_attention';
  retriesUsed: number;
  nextRetryAt: string | null;
  reason: string | null;
  chargedCredits: number;
  unknownCharges: number;
}
export type LocalOutcome = 'generation' | 'stopped-before-dispatch';
