export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

export interface ShutdownSignalSource {
  on(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
}

/**
 * Runs `stop` once, on the first SIGTERM or SIGINT. Those signals start the adapter's drain, and
 * scripts/start.ts delivers a SIGHUP to it as SIGTERM, so this is the start of every graceful
 * shutdown. The process exits at the SHUTDOWN_TIMEOUT deadline whatever the app is still doing, so
 * a background worker that runs until then can be cut off while it holds a work lease, and a leaked
 * lease keeps the next process away from that work until the lease expires. Stopping the workers
 * here gives them the whole drain budget to settle. Exiting stays with the adapter, which still
 * exits at once on a second signal. Returns a function that removes the listeners.
 */
export function stopOnShutdownSignal(
  stop: () => Promise<unknown>,
  source: ShutdownSignalSource = process
): () => void {
  const remove = () => {
    for (const signal of SHUTDOWN_SIGNALS) source.off(signal, onSignal);
  };
  const onSignal = () => {
    remove();
    void stop().catch(() => undefined);
  };
  for (const signal of SHUTDOWN_SIGNALS) source.on(signal, onSignal);
  return remove;
}
