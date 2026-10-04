// Production entry (`bun run start`). SvelteKit 3 has no runtime ORIGIN, and the official Bun adapter
// treats a request as HTTPS unless a trusted proxy names the scheme. This loopback listener is that
// proxy: it owns the public port, reaches the adapter over a private Unix socket, and overwrites the
// adapter's protocol and host headers with its own origin on every request, so client-supplied
// values are never trusted. One build therefore serves any loopback host and runtime port.
export type LoopbackHost = '127.0.0.1' | '::1';
type Environment = Record<string, string | undefined>;

export const PROTOCOL_HEADER = 'x-poyo-listener-proto';
export const HOST_HEADER = 'x-poyo-listener-host';
// The client address the adapter reports (ADDRESS_HEADER): the TCP peer of this listener.
export const PEER_HEADER = 'x-poyo-listener-peer';

// Owner decision M6: the adapter's 512K default rejected source uploads the app accepts. Default to
// the app's whole-request cap, REQUEST_MAX_BYTES in src/lib/server/media/source-intake.ts
// (POYO_STREAM_VIDEO_MAX_BYTES, 100 MiB in src/lib/server/poyo/uploads.ts, plus 1 MiB of multipart
// allowance), so the transport never rejects a request the app accepts. adapter-bun reads `M` as
// 1024 * 1024.
export const DEFAULT_BODY_SIZE_LIMIT = '101M';

// Owner decision M4(a): browsers keep job event streams open, so bound the adapter's drain to 1 s
// instead of its 30 s default. An operator-set value wins.
export const DEFAULT_SHUTDOWN_TIMEOUT = '1';

export function resolveLoopbackHost(value: string | undefined): LoopbackHost {
  const host = value?.trim() || '127.0.0.1';
  if (host === '127.0.0.1' || host === '::1') return host;
  throw new Error('HOST must be 127.0.0.1 or ::1. Non-loopback listeners are not supported.');
}

function resolvePort(value: string | undefined): number {
  const text = value?.trim() || '3000';
  if (!/^\d+$/.test(text) || Number(text) > 65535) {
    throw new Error('PORT must be an integer from 0 to 65535.');
  }
  return Number(text);
}

function resolveIdleTimeout(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^\d+$/.test(value) || Number(value) > 255) {
    throw new Error('CONNECTION_IDLE_TIMEOUT must be an integer from 0 to 255.');
  }
  return Number(value);
}

/**
 * Parses a configured ORIGIN. The error never echoes the value, which may carry credentials, and
 * never wraps the URL parser's error (Bun keeps the raw value in its `input` property).
 */
function resolveConfiguredOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    // replaced by the redacted error below
  }
  if (!url)
    throw new Error('ORIGIN is not a valid URL. Leave it unset or set the listener origin.');
  // A trailing slash is the only spelling difference accepted; anything else is a mismatch.
  return url.origin === value.replace(/\/$/, '') ? url.origin : value;
}

/** The adapter's SHUTDOWN_TIMEOUT in seconds, parsed as adapter-bun parses it (default 30). */
export function shutdownTimeoutSeconds(environment: Environment): number {
  const value = environment.SHUTDOWN_TIMEOUT;
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : 30;
}

export interface Listener {
  readonly url: URL;
  stop(closeActiveConnections?: boolean): Promise<void> | void;
}

export type Listen = (options: {
  hostname: LoopbackHost;
  port: number;
  socket: string;
  idleTimeout: number | undefined;
  /** Settles once the adapter has loaded; requests that arrive earlier wait for it. */
  ready: Promise<void>;
}) => Listener;

export async function start(
  environment: Environment = process.env,
  importServer: () => Promise<unknown> = () =>
    import(pathToFileURL(resolve('build/index.js')).href),
  listen: Listen = serveLoopback
): Promise<Listener> {
  const hostname = resolveLoopbackHost(environment.HOST);
  const port = resolvePort(environment.PORT);
  // The operator's client idle timeout applies at this listener (read before the override below).
  const idleTimeout = resolveIdleTimeout(environment.CONNECTION_IDLE_TIMEOUT);
  const configuredOrigin = resolveConfiguredOrigin(environment.ORIGIN);

  environment.HOST = hostname;
  const directory = mkdtempSync(join(environment.TMPDIR?.trim() || tmpdir(), 'poyo-studio-'));
  const socket = join(directory, 'app.sock');
  const removeSocketDirectory = () => rmSync(directory, { recursive: true, force: true });
  environment.SOCKET_PATH = socket;
  environment.PROTOCOL_HEADER = PROTOCOL_HEADER;
  environment.HOST_HEADER = HOST_HEADER;
  delete environment.PORT_HEADER;
  // Over the socket the adapter would see no client address, so this listener reports its TCP peer.
  // An operator ADDRESS_HEADER is not honoured: only a local process can sit in front of a loopback
  // listener, so a forwarded address (and XFF_DEPTH) could only ever come from the client itself.
  environment.ADDRESS_HEADER = PEER_HEADER;
  delete environment.XFF_DEPTH;
  // Over the socket the adapter's event-stream idle exemption does not take effect (Bun 1.4.2), so
  // its own idle timeout would cut idle job streams; this listener applies the client timeout.
  environment.CONNECTION_IDLE_TIMEOUT = '0';
  environment.SHUTDOWN_TIMEOUT ??= DEFAULT_SHUTDOWN_TIMEOUT;
  environment.BODY_SIZE_LIMIT ??= DEFAULT_BODY_SIZE_LIMIT;

  let markReady = () => {};
  const ready = new Promise<void>((resolveReady) => {
    markReady = resolveReady;
  });

  // Bind the public port before loading the adapter, so a busy port never starts the app.
  let listener: Listener;
  try {
    listener = listen({ hostname, port, socket, idleTimeout, ready });
  } catch (error) {
    removeSocketDirectory();
    throw error;
  }
  const origin = listener.url.origin;

  // Shutdown drains both sides within one budget from the first signal. The adapter drains the
  // socket side for up to SHUTDOWN_TIMEOUT and then emits sveltekit:shutdown; a slow client can still
  // be downloading from this listener at that point, so wait for the public drain until the same
  // deadline and force-close only what is left after it.
  let deadline = 0;
  let publicDrain: Promise<void> | undefined;
  const startDrain = () => {
    if (!publicDrain) {
      deadline = Date.now() + shutdownTimeoutSeconds(environment) * 1000;
      publicDrain = Promise.resolve(listener.stop());
    }
    return publicDrain;
  };
  // The adapter installs its own SIGTERM/SIGINT handlers only once it has loaded. A signal that
  // arrives earlier is remembered and delivered again then, so the adapter still drains and emits
  // sveltekit:shutdown instead of leaving a running app behind a stopped listener. A second signal
  // before then exits with status 1, as the adapter does for a second signal. These handlers stay
  // registered, so a later signal never falls back to the default handler, which skips the exit
  // cleanup below.
  let loaded = false;
  let earlySignal: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    startDrain();
    if (loaded) return;
    if (earlySignal) process.exit(1);
    earlySignal = signal;
  };
  const onShutdown = async () => {
    const drain = startDrain();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      drain.then(() => true),
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), Math.max(0, deadline - Date.now()));
      })
    ]);
    clearTimeout(timer);
    if (!drained) await listener.stop(true);
    removeSocketDirectory();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  process.once('sveltekit:shutdown', onShutdown);
  // Every exit, including the adapter's process.exit(1) on a second signal, removes the socket
  // directory (synchronously, as exit handlers must).
  process.once('exit', removeSocketDirectory);

  try {
    if (configuredOrigin !== undefined && configuredOrigin !== origin) {
      throw new Error(`ORIGIN does not match the listener origin ${origin}.`);
    }
    await importServer();
  } catch (error) {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    process.off('sveltekit:shutdown', onShutdown);
    process.off('exit', removeSocketDirectory);
    await listener.stop(true);
    removeSocketDirectory();
    throw error;
  }
  loaded = true;
  markReady();
  if (earlySignal) process.kill(process.pid, earlySignal);
  console.log(`Listening on ${origin}`);
  return listener;
}

function serveLoopback({ hostname, port, socket, idleTimeout, ready }: Parameters<Listen>[0]) {
  let authority = '';
  const server = Bun.serve({
    hostname,
    port,
    ...(idleTimeout === undefined ? {} : { idleTimeout }),
    // The adapter enforces BODY_SIZE_LIMIT on the forwarded stream.
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    async fetch(request, server) {
      await ready;
      const headers = new Headers(request.headers);
      headers.set(PROTOCOL_HEADER, 'http');
      headers.set(HOST_HEADER, authority);
      // Replaces any client-sent copy.
      headers.set(PEER_HEADER, server.requestIP(request)?.address ?? '');
      let response: Response;
      try {
        response = await fetch(`http://localhost${forwardPath(request.url)}`, {
          method: request.method,
          headers,
          body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
          redirect: 'manual',
          decompress: false,
          signal: request.signal,
          unix: socket
        });
      } catch {
        return new Response('Service Unavailable', { status: 503 });
      }
      if (response.headers.get('content-type')?.startsWith('text/event-stream') && response.body) {
        server.timeout(request, 0);
        return new Response(endCleanlyOnUpstreamError(response.body), response);
      }
      return response;
    }
  });
  authority = server.url.host;
  return server;
}

/**
 * The path and query of a request exactly as Bun received them, sliced after any authority. Never
 * `new URL(request.url)`: Bun builds `request.url` from the client's Host header, and some Host
 * values (for example `[::1` or `x:99999`) make it unparsable.
 */
export function forwardPath(requestUrl: string): string {
  const scheme = requestUrl.indexOf('://');
  const start = scheme === -1 ? 0 : requestUrl.indexOf('/', scheme + 3);
  return start === -1 ? '/' : requestUrl.slice(start);
}

/**
 * Event streams have no length, so a stream the adapter closes (on shutdown it force-closes them after
 * SHUTDOWN_TIMEOUT) ends here as a normal end of stream, and the browser's EventSource reconnects.
 * Passing the upstream error on would reset the client connection instead. Other responses keep the
 * error, so a truncated download never looks complete.
 */
function endCleanlyOnUpstreamError(
  upstream: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch {
        controller.close();
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });
}

if (import.meta.main) await start();

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
