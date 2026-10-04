import { isExactIsoUtcInstant } from '#lib/features/library/contracts.js';

interface DownloadCopyResult {
  requestedAt: string;
}

interface DownloadCopyOptions {
  onaccepted?: (result: DownloadCopyResult) => void;
  onerror?: () => void;
  oninvalidate?: () => Promise<void>;
}

function isAcceptedResponse(value: unknown): value is { accepted: true; requestedAt: string } {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  const keys = Object.keys(result);
  return (
    keys.length === 2 &&
    Object.hasOwn(result, 'accepted') &&
    Object.hasOwn(result, 'requestedAt') &&
    result.accepted === true &&
    isExactIsoUtcInstant(result.requestedAt)
  );
}

export async function downloadCopy(
  outputId: string,
  options: DownloadCopyOptions = {}
): Promise<void> {
  try {
    const requestToken = crypto.randomUUID();
    const response = await fetch(`/api/media/${encodeURIComponent(outputId)}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestToken })
    });
    const result: unknown = await response.json().catch(() => null);
    if (!response.ok || !isAcceptedResponse(result))
      throw new Error('Download copy request failed.');

    const anchor = document.createElement('a');
    anchor.href = `/api/media/${encodeURIComponent(outputId)}/download?request=${encodeURIComponent(requestToken)}`;
    anchor.dataset.sveltekitReload = 'true';
    anchor.hidden = true;
    anchor.download = '';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();

    options.onaccepted?.({ requestedAt: result.requestedAt });
    void options.oninvalidate?.().catch(() => undefined);
  } catch {
    options.onerror?.();
  }
}
