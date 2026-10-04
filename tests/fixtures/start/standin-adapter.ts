// Stand-in for the adapter-bun build output, used by tests/unit/platform/start.test.ts: the test
// writes a build/index.js that imports this file. Like @sveltejs/adapter-bun 1.0.0 it listens on
// SOCKET_PATH, installs its SIGTERM/SIGINT handlers only once it has loaded, drains for up to
// SHUTDOWN_TIMEOUT seconds, and then emits sveltekit:shutdown without exiting.
import process from 'node:process';

const env = process.env;
if (env.STANDIN_THROW === '1') throw new Error('stand-in adapter failed to load');
if (env.STANDIN_LOAD_DELAY_MS) await Bun.sleep(Number(env.STANDIN_LOAD_DELAY_MS));

const seen = Object.fromEntries(
  [
    'SOCKET_PATH',
    'PROTOCOL_HEADER',
    'HOST_HEADER',
    'PORT_HEADER',
    'ADDRESS_HEADER',
    'XFF_DEPTH',
    'CONNECTION_IDLE_TIMEOUT',
    'SHUTDOWN_TIMEOUT',
    'BODY_SIZE_LIMIT'
  ].map((name) => [name, env[name] ?? null])
);
const big = new Uint8Array(Number(env.STANDIN_BIG_BYTES || 8 * 1024 * 1024)).fill(97);
const encoder = new TextEncoder();

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  switch (url.pathname) {
    case '/echo':
      return Response.json({
        method: request.method,
        path: url.pathname,
        search: url.search,
        body: await request.text(),
        headers: Object.fromEntries(request.headers),
        env: seen
      });
    case '/redirect':
      return new Response(null, { status: 302, headers: { location: '/elsewhere' } });
    case '/gzip':
      return new Response(Bun.gzipSync(encoder.encode('compressed body')), {
        headers: { 'content-encoding': 'gzip', 'content-type': 'text/plain' }
      });
    case '/sse': {
      const gap = Number(url.searchParams.get('gap') || 2000);
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode('data: one\n\n'));
          await Bun.sleep(gap);
          controller.enqueue(encoder.encode('data: two\n\n'));
          controller.close();
        }
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    case '/sse-open': {
      // One event, then idle until the client leaves or the server closes the connection.
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: one\n\n'));
        }
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    case '/big':
      return new Response(big, { headers: { 'content-type': 'application/octet-stream' } });
    case '/stop':
      setTimeout(() => server.stop(true), 10);
      return new Response('stopping');
    default:
      return new Response('not found', { status: 404 });
  }
}

// Bun's typings allow no idleTimeout on a Unix-socket listener; the front sets the adapter's
// CONNECTION_IDLE_TIMEOUT to 0 (disabled) anyway.
const server = Bun.serve({ unix: String(env.SOCKET_PATH), fetch: handle });
console.log('standin listening');

let stopping = false;
async function shutdown(reason: string) {
  if (stopping) process.exit(1);
  stopping = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drained = await Promise.race([
    server.stop().then(() => true),
    new Promise<false>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(false), Number(env.SHUTDOWN_TIMEOUT ?? 30) * 1000);
    })
  ]);
  clearTimeout(timer);
  if (!drained) await server.stop(true);
  console.log('standin drained');
  // A custom process event, as the adapter emits it; Node's typings list only built-in events.
  (process.emit as (event: string, ...args: unknown[]) => boolean)('sveltekit:shutdown', reason);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
