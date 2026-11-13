import type { StudioJobDto } from './contracts';
import { isJob } from './studio-batch';

/** Accept a stop only after the server confirms it; failures leave the local job unchanged. */
export async function requestStopRetries(
  id: string,
  send: (input: string, init?: RequestInit) => Promise<Response> = fetch
): Promise<StudioJobDto> {
  const response = await send(`/api/jobs/${encodeURIComponent(id)}/stop-retries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
  const payload: unknown = await response.json();
  const data = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  if (!response.ok)
    throw new Error(`Could not stop future retries (${response.status}). Try again.`);
  if (
    !isJob(data.job) ||
    data.job.id !== id ||
    !data.job.automaticRetry ||
    data.job.automaticRetry.state === 'running'
  )
    throw new Error('The server did not confirm stopping future retries. Try again.');
  return data.job;
}
