import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_BODY_SIZE_LIMIT,
  DEFAULT_SHUTDOWN_TIMEOUT,
  forwardPath,
  HOST_HEADER,
  type Listen,
  PEER_HEADER,
  PROTOCOL_HEADER,
  resolveLoopbackHost,
  shutdownTimeoutSeconds,
  start
} from '../../../scripts/start';
import { REQUEST_MAX_BYTES } from '../../../src/lib/server/media/source-intake';
import { POYO_STREAM_VIDEO_MAX_BYTES } from '../../../src/lib/server/poyo/uploads';

const START = resolve('scripts/start.ts');
const STANDIN = resolve('tests/fixtures/start/standin-adapter.ts');
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'poyo-start-test-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const socketDirectories = (directory: string) =>
  readdirSync(directory).filter((name) => name.startsWith('poyo-studio-'));

function freePort(): number {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
}

const fakeListen: Listen = ({ hostname, port }) => ({
  url: new URL(`http://${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}`),
  stop() {}
});

const startEvents = ['SIGTERM', 'SIGINT', 'sveltekit:shutdown', 'exit'] as const;

/**
 * Runs `fn` and then removes the signal and shutdown listeners start() added, which it keeps for the
 * life of the process.
 */
async function withoutStartListeners<T>(fn: () => Promise<T>): Promise<T> {
  const before = new Map(startEvents.map((event) => [event, new Set(process.listeners(event))]));
  try {
    return await fn();
  } finally {
    for (const event of startEvents) {
      for (const listener of process.listeners(event)) {
        if (!before.get(event)?.has(listener)) process.off(event, listener as () => void);
      }
    }
  }
}

/** Runs start() with a fake listener and a private TMPDIR, and returns the prepared environment. */
async function prepared(environment: Record<string, string | undefined>) {
  const temp = scratch();
  const env: Record<string, string | undefined> = { TMPDIR: temp, ...environment };
  await withoutStartListeners(() => start(env, async () => {}, fakeListen));
  return { env, temp };
}

function parseBinaryBytes(value: string): number {
  const match = /^(\d+)([KMG])$/.exec(value);
  if (!match) throw new Error(`unexpected byte value ${value}`);
  const exponent = { K: 1, M: 2, G: 3 }[match[2] as 'K' | 'M' | 'G'];
  return Number(match[1]) * 1024 ** exponent;
}

describe('production start host policy', () => {
  test('defaults unset or blank hosts and accepts exact trimmed loopback addresses', () => {
    expect(resolveLoopbackHost(undefined)).toBe('127.0.0.1');
    expect(resolveLoopbackHost('')).toBe('127.0.0.1');
    expect(resolveLoopbackHost('   ')).toBe('127.0.0.1');
    expect(resolveLoopbackHost(' 127.0.0.1 ')).toBe('127.0.0.1');
    expect(resolveLoopbackHost('\t::1\n')).toBe('::1');
  });

  test('rejects hostnames, wildcard, mapped, and LAN addresses', () => {
    for (const host of ['localhost', '0.0.0.0', '::', '::ffff:127.0.0.1', '192.168.1.20']) {
      expect(() => resolveLoopbackHost(host), host).toThrow('HOST must be 127.0.0.1 or ::1');
    }
  });

  test('validates and normalizes HOST before importing the built server', async () => {
    const temp = scratch();
    const validEnvironment: Record<string, string | undefined> = { HOST: ' ::1 ', TMPDIR: temp };
    let importedHost: string | undefined;
    const listener = await withoutStartListeners(() =>
      start(
        validEnvironment,
        async () => {
          importedHost = validEnvironment.HOST;
        },
        fakeListen
      )
    );
    expect(importedHost).toBe('::1');
    expect(listener.url.origin).toBe('http://[::1]:3000');

    let imported = false;
    await expect(
      start({ HOST: 'example.test', TMPDIR: temp }, async () => {
        imported = true;
      })
    ).rejects.toThrow('Non-loopback listeners are not supported');
    expect(imported).toBe(false);
  });
});

describe('production start adapter environment', () => {
  test('points the adapter at a private socket and owns the origin headers', async () => {
    const { env, temp } = await prepared({
      PORT_HEADER: 'x-forwarded-port',
      PROTOCOL_HEADER: 'x-forwarded-proto',
      HOST_HEADER: 'x-forwarded-host',
      CONNECTION_IDLE_TIMEOUT: '15'
    });
    const [directory] = socketDirectories(temp);
    expect(env.SOCKET_PATH).toBe(join(temp, String(directory), 'app.sock'));
    expect(env.PROTOCOL_HEADER).toBe(PROTOCOL_HEADER);
    expect(env.HOST_HEADER).toBe(HOST_HEADER);
    expect(env).not.toHaveProperty('PORT_HEADER');
    expect(env.CONNECTION_IDLE_TIMEOUT).toBe('0');
  });

  test('owns the address header and ignores an operator ADDRESS_HEADER and XFF_DEPTH', async () => {
    expect((await prepared({})).env.ADDRESS_HEADER).toBe(PEER_HEADER);
    const { env } = await prepared({ ADDRESS_HEADER: 'x-forwarded-for', XFF_DEPTH: '2' });
    expect(env.ADDRESS_HEADER).toBe(PEER_HEADER);
    expect(env).not.toHaveProperty('XFF_DEPTH');
  });

  test('passes the operator idle timeout to the listener, not the adapter', async () => {
    const temp = scratch();
    let idle: number | undefined = -1;
    await withoutStartListeners(() =>
      start(
        { TMPDIR: temp, CONNECTION_IDLE_TIMEOUT: '15' },
        async () => {},
        (options) => {
          idle = options.idleTimeout;
          return fakeListen(options);
        }
      )
    );
    expect(idle).toBe(15);
  });

  test('defaults SHUTDOWN_TIMEOUT to 1 second and keeps an operator value (M4a)', async () => {
    expect(DEFAULT_SHUTDOWN_TIMEOUT).toBe('1');
    expect((await prepared({})).env.SHUTDOWN_TIMEOUT).toBe('1');
    expect((await prepared({ SHUTDOWN_TIMEOUT: '30' })).env.SHUTDOWN_TIMEOUT).toBe('30');
    expect(shutdownTimeoutSeconds({})).toBe(30);
    expect(shutdownTimeoutSeconds({ SHUTDOWN_TIMEOUT: '5' })).toBe(5);
  });

  test('defaults BODY_SIZE_LIMIT to the source upload cap and keeps an operator value (M6)', async () => {
    // The default must equal the app's own whole-request cap, so the app answers oversize uploads.
    expect(parseBinaryBytes(DEFAULT_BODY_SIZE_LIMIT)).toBe(REQUEST_MAX_BYTES);
    expect(REQUEST_MAX_BYTES).toBe(POYO_STREAM_VIDEO_MAX_BYTES + 1024 * 1024);

    expect((await prepared({})).env.BODY_SIZE_LIMIT).toBe(DEFAULT_BODY_SIZE_LIMIT);
    for (const operator of ['2M', '512K', 'Infinity', '104857600']) {
      expect((await prepared({ BODY_SIZE_LIMIT: operator })).env.BODY_SIZE_LIMIT).toBe(operator);
    }
  });

  test('rejects an invalid PORT or CONNECTION_IDLE_TIMEOUT before creating a socket directory', async () => {
    const temp = scratch();
    for (const [environment, message] of [
      [{ PORT: 'http' }, 'PORT must be an integer'],
      [{ PORT: '70000' }, 'PORT must be an integer'],
      [{ CONNECTION_IDLE_TIMEOUT: '300' }, 'CONNECTION_IDLE_TIMEOUT must be an integer'],
      [{ CONNECTION_IDLE_TIMEOUT: 'soon' }, 'CONNECTION_IDLE_TIMEOUT must be an integer']
    ] as const) {
      await expect(
        start({ TMPDIR: temp, ...environment }, async () => {}, fakeListen)
      ).rejects.toThrow(message);
    }
    expect(socketDirectories(temp)).toEqual([]);
  });
});

describe('production start ORIGIN check', () => {
  test('accepts an ORIGIN equal to the listener origin', async () => {
    for (const origin of ['http://127.0.0.1:3000', 'http://127.0.0.1:3000/']) {
      const { env } = await prepared({ ORIGIN: origin });
      expect(env.ORIGIN).toBe(origin);
    }
  });

  test('fails startup on a mismatched or malformed ORIGIN without echoing it', async () => {
    const temp = scratch();
    const secret = `pw-${Math.random().toString(36).slice(2)}`;
    for (const origin of [
      'http://127.0.0.1:1',
      'https://127.0.0.1:3000',
      'http://127.0.0.1:3000/app',
      `http://user:${secret}@127.0.0.1:3000`,
      `http://user:${secret}@exa mple.test`
    ]) {
      let imported = false;
      let caught: unknown;
      try {
        await start(
          { TMPDIR: temp, ORIGIN: origin },
          async () => {
            imported = true;
          },
          fakeListen
        );
      } catch (error) {
        caught = error;
      }
      expect(caught, origin).toBeInstanceOf(Error);
      const error = caught as Error;
      expect(error.message, origin).toMatch(
        /^ORIGIN (does not match the listener origin http:\/\/127\.0\.0\.1:3000\.|is not a valid URL\.)/
      );
      expect(error.cause, origin).toBeUndefined();
      expect(Object.keys(error), origin).toEqual([]);
      expect(error.message, origin).not.toContain(secret);
      expect(imported, origin).toBe(false);
    }
    expect(socketDirectories(temp)).toEqual([]);
  });
});

describe('production start path forwarding', () => {
  test('forwards the raw path and query, whatever the authority', () => {
    expect(forwardPath('http://x/_app/immutable/a%2Db.js?v=%2F&q')).toBe(
      '/_app/immutable/a%2Db.js?v=%2F&q'
    );
    expect(forwardPath('http://[::1/echo?x=1')).toBe('/echo?x=1');
    expect(forwardPath('http://x:99999/echo')).toBe('/echo');
    expect(forwardPath('/echo?x=1')).toBe('/echo?x=1');
    // What Bun gives for a Host it cannot parse: a bare path, whose query may hold a URL.
    expect(forwardPath('/login?next=http://x/y')).toBe('/login?next=http://x/y');
    expect(forwardPath('/p%2Fq?x=%20')).toBe('/p%2Fq?x=%20');
    expect(forwardPath('http://x//double')).toBe('//double');
    expect(forwardPath('http://x')).toBe('/');
  });
});

describe('production start failures leave nothing behind', () => {
  test('a failing server import rejects, frees the port, and removes the socket directory', async () => {
    const temp = scratch();
    const port = freePort();
    const listenersBefore = startEvents.map((event) => process.listenerCount(event));
    const failure = new Error('build output failed to load');
    await expect(
      start({ TMPDIR: temp, PORT: String(port) }, () => Promise.reject(failure))
    ).rejects.toBe(failure);
    expect(socketDirectories(temp)).toEqual([]);
    expect(startEvents.map((event) => process.listenerCount(event))).toEqual(listenersBefore);
    const rebound = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('ok') });
    rebound.stop(true);
  });

  test('a taken port rejects before the server loads and removes the socket directory', async () => {
    const temp = scratch();
    const blocker = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('busy')
    });
    cleanups.push(() => blocker.stop(true));
    let imported = false;
    await expect(
      start({ TMPDIR: temp, PORT: String(blocker.port) }, async () => {
        imported = true;
      })
    ).rejects.toThrow(/in use|EADDRINUSE/i);
    expect(imported).toBe(false);
    expect(socketDirectories(temp)).toEqual([]);
  });
});

interface Started {
  proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  port: number;
  temp: string;
  output: () => string;
}

/** Runs `bun scripts/start.ts` against the stand-in adapter, with a private TMPDIR. */
async function launch(
  environment: Record<string, string> = {},
  waitFor: 'ready' | 'none' = 'ready'
): Promise<Started> {
  const cwd = scratch();
  const temp = scratch();
  mkdirSync(join(cwd, 'build'));
  writeFileSync(join(cwd, 'build', 'index.js'), `await import(${JSON.stringify(STANDIN)});\n`);
  const port = freePort();
  const proc = Bun.spawn({
    cmd: [process.execPath, START],
    cwd,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: temp,
      HOST: '127.0.0.1',
      PORT: String(port),
      ...environment
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  });
  cleanups.push(() => proc.kill('SIGKILL'));
  let output = '';
  const decoder = new TextDecoder();
  for (const stream of [proc.stdout, proc.stderr]) {
    void (async () => {
      for await (const chunk of stream) output += decoder.decode(chunk);
    })();
  }
  if (waitFor === 'ready') {
    const deadline = Date.now() + 10_000;
    while (!output.includes('Listening on http')) {
      if (Date.now() > deadline || proc.exitCode !== null) {
        throw new Error(`start.ts did not start:\n${output}`);
      }
      await Bun.sleep(25);
    }
  }
  return { proc, port, temp, output: () => output };
}

/**
 * Waits until the public port accepts a TCP connection. start.ts binds it before loading the
 * adapter and installs its signal handlers in the same turn, so they exist by then.
 */
async function waitForPort(started: Started, timeoutMs = 5000) {
  const accepting = async () => {
    try {
      const socket = await Bun.connect({
        hostname: '127.0.0.1',
        port: started.port,
        socket: { data() {} }
      });
      socket.end();
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + timeoutMs;
  while (!(await accepting())) {
    if (Date.now() > deadline) throw new Error(`port never opened:\n${started.output()}`);
    await Bun.sleep(25);
  }
}

async function waitForOutput(started: Started, text: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!started.output().includes(text)) {
    if (Date.now() > deadline) throw new Error(`no "${text}" in:\n${started.output()}`);
    await Bun.sleep(25);
  }
}

/** Sends a raw HTTP/1.1 GET with the given Host header, which fetch() would not send as is. */
async function rawGet(port: number, host: string, target: string) {
  const decoder = new TextDecoder();
  let raw = '';
  await new Promise<void>((resolveClosed, rejectClosed) => {
    Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(socket) {
          socket.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
        },
        data(_socket, chunk) {
          raw += decoder.decode(chunk);
        },
        close() {
          resolveClosed();
        },
        error(_socket, error) {
          rejectClosed(error);
        }
      }
    }).catch(rejectClosed);
  });
  const [head = '', ...rest] = raw.split('\r\n\r\n');
  const status = Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1]);
  const chunked = /^transfer-encoding: chunked$/im.test(head);
  const body = rest.join('\r\n\r\n');
  return { status, body: chunked ? dechunk(body) : body };
}

/** Sends `raw` on a new connection; the seconds until the server closes it (Infinity after 10 s). */
function secondsUntilClosed(port: number, raw: string): Promise<number> {
  return new Promise((done) => {
    const started = Date.now();
    const timer = setTimeout(() => done(Number.POSITIVE_INFINITY), 10_000);
    const closed = () => {
      clearTimeout(timer);
      done((Date.now() - started) / 1000);
    };
    Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(socket) {
          cleanups.push(() => socket.end());
          socket.write(raw);
        },
        data() {},
        close: closed,
        error: closed
      }
    }).catch(closed);
  });
}

function dechunk(body: string): string {
  let out = '';
  let rest = body;
  for (;;) {
    const lineEnd = rest.indexOf('\r\n');
    const size = Number.parseInt(rest.slice(0, lineEnd), 16);
    if (!size) return out;
    out += rest.slice(lineEnd + 2, lineEnd + 2 + size);
    rest = rest.slice(lineEnd + 2 + size + 2);
  }
}

/**
 * Reads a response body slowly, about `bytesPerSecond`, and reports what arrived. Once `hurry.now`
 * is set it reads whatever is left without pausing.
 */
async function slowRead(response: Response, bytesPerSecond: number, hurry = { now: false }) {
  let bytes = 0;
  try {
    const reader = response.body?.getReader();
    if (!reader) return { bytes, error: 'no body' };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { bytes, error: undefined };
      bytes += value.byteLength;
      if (!hurry.now) await Bun.sleep(Math.ceil((value.byteLength / bytesPerSecond) * 1000));
    }
  } catch (error) {
    return { bytes, error };
  }
}

describe('production start loopback front (process)', () => {
  test('forwards requests and overwrites client-supplied origin and peer headers', async () => {
    // An operator address header is ignored: on a loopback listener it could only be client-sent.
    const app = await launch({ ADDRESS_HEADER: 'x-forwarded-for', XFF_DEPTH: '2' });
    const base = `http://127.0.0.1:${app.port}`;
    const seen = (await (
      await fetch(`${base}/echo?x=1`, {
        method: 'POST',
        body: 'hello',
        headers: {
          host: 'evil.example',
          [PROTOCOL_HEADER]: 'https',
          [HOST_HEADER]: 'evil.example',
          [PEER_HEADER]: '203.0.113.7',
          'x-forwarded-for': '203.0.113.7, 198.51.100.9'
        }
      })
    ).json()) as {
      method: string;
      path: string;
      search: string;
      body: string;
      headers: Record<string, string>;
      env: Record<string, string | null>;
    };
    expect(seen).toMatchObject({ method: 'POST', path: '/echo', search: '?x=1', body: 'hello' });
    expect(seen.headers[PROTOCOL_HEADER]).toBe('http');
    expect(seen.headers[HOST_HEADER]).toBe(`127.0.0.1:${app.port}`);
    expect(seen.headers[PEER_HEADER]).toBe('127.0.0.1');
    expect(seen.env).toMatchObject({
      PROTOCOL_HEADER,
      HOST_HEADER,
      PORT_HEADER: null,
      ADDRESS_HEADER: PEER_HEADER,
      XFF_DEPTH: null,
      CONNECTION_IDLE_TIMEOUT: '0',
      SHUTDOWN_TIMEOUT: DEFAULT_SHUTDOWN_TIMEOUT,
      BODY_SIZE_LIMIT: DEFAULT_BODY_SIZE_LIMIT
    });
    expect(seen.env.SOCKET_PATH).toBe(
      join(app.temp, String(socketDirectories(app.temp)[0]), 'app.sock')
    );

    const redirect = await fetch(`${base}/redirect`, { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('/elsewhere');
    const gzip = await fetch(`${base}/gzip`, {
      headers: { 'accept-encoding': 'gzip' },
      decompress: false
    });
    expect(gzip.headers.get('content-encoding')).toBe('gzip');
    expect(new Uint8Array(await gzip.arrayBuffer()).subarray(0, 2)).toEqual(
      new Uint8Array([0x1f, 0x8b])
    );

    await fetch(`${base}/stop`).then((response) => response.text());
    await Bun.sleep(100);
    expect((await fetch(`${base}/echo`)).status).toBe(503);
  });

  test('forwards requests whose Host header is not a valid URL authority', async () => {
    // The front must not parse request.url (500); the adapter answers such a request itself.
    const app = await launch();
    for (const host of ['[::1', 'x:99999', '%']) {
      const response = await rawGet(app.port, host, '/echo?x=1');
      expect(response.status, host).toBe(400);
      expect(JSON.parse(response.body), host).toEqual({
        error: 'Bad Request',
        target: '/echo?x=1'
      });
    }
    expect(app.output()).not.toContain('Invalid URL');
  });

  test('keeps an idle event stream open past the client idle timeout', async () => {
    const app = await launch({ CONNECTION_IDLE_TIMEOUT: '1' });
    const response = await fetch(`http://127.0.0.1:${app.port}/sse?gap=2500`);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toBe('data: one\n\ndata: two\n\n');
  }, 15_000);

  // Bun 1.4.2 runs the listener's idle timer while the handler awaits fetch() to the adapter: without
  // the fix, a request the app answered after the idle window got an empty reply (a closed connection).
  test('answers requests the adapter takes longer than the client idle timeout to answer', async () => {
    const app = await launch({ CONNECTION_IDLE_TIMEOUT: '1' });
    const base = `http://127.0.0.1:${app.port}`;
    const [get, post] = await Promise.all([
      fetch(`${base}/slow?ms=4500`).then(async (r) => [r.status, await r.text()]),
      fetch(`${base}/slow?ms=4500`, { method: 'POST', body: 'abc' }).then(async (r) => [
        r.status,
        await r.text()
      ])
    ]);
    expect(get).toEqual([200, 'slow 0']);
    expect(post).toEqual([200, 'slow 3']);
  }, 15_000);

  test('still closes a client that stalls before its request body is complete', async () => {
    const app = await launch({ CONNECTION_IDLE_TIMEOUT: '1' });
    const stalled = secondsUntilClosed(
      app.port,
      'POST /slow?ms=0 HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\nhello'
    );
    expect(await stalled).toBeLessThan(8);
  }, 15_000);

  test('re-arms the client idle timeout once the adapter has answered', async () => {
    const app = await launch({ CONNECTION_IDLE_TIMEOUT: '1' });
    // A keep-alive connection that goes idle after a slow answer is closed like any other.
    const idle = secondsUntilClosed(
      app.port,
      'GET /slow?ms=1500 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'
    );
    expect(await idle).toBeLessThan(8);
  }, 15_000);

  test('on SIGTERM a slow client still receives the full body before the listener stops', async () => {
    const app = await launch({ SHUTDOWN_TIMEOUT: '5' });
    const base = `http://127.0.0.1:${app.port}`;
    expect(socketDirectories(app.temp)).toHaveLength(1);
    const response = await fetch(`${base}/big`);
    const download = slowRead(response, 4 * 1024 * 1024);
    await Bun.sleep(300);
    app.proc.kill('SIGTERM');
    // The adapter side drains first and emits sveltekit:shutdown while the client still reads.
    await waitForOutput(app, 'standin drained');
    const result = await download;
    expect(result.error).toBeUndefined();
    expect(result.bytes).toBe(8 * 1024 * 1024);
    expect(await app.proc.exited).toBe(0);
    expect(socketDirectories(app.temp)).toEqual([]);
  }, 30_000);

  test('on SIGTERM ends an open event stream cleanly when the adapter closes it', async () => {
    const app = await launch({ SHUTDOWN_TIMEOUT: '1' });
    const response = await fetch(`http://127.0.0.1:${app.port}/sse-open`);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const body = response.text();
    await Bun.sleep(300);
    app.proc.kill('SIGTERM');
    // A normal end of stream (EventSource reconnects), not a reset connection.
    expect(await body).toBe('data: one\n\n');
    expect(await app.proc.exited).toBe(0);
    expect(socketDirectories(app.temp)).toEqual([]);
  }, 15_000);

  test('force-closes a client that cannot finish within SHUTDOWN_TIMEOUT', async () => {
    const app = await launch({ SHUTDOWN_TIMEOUT: '2' });
    const response = await fetch(`http://127.0.0.1:${app.port}/big`);
    const hurry = { now: false };
    const download = slowRead(response, 256 * 1024, hurry);
    await Bun.sleep(300);
    const signalled = Date.now();
    app.proc.kill('SIGTERM');
    expect(await app.proc.exited).toBe(0);
    const elapsed = (Date.now() - signalled) / 1000;
    hurry.now = true;
    // About SHUTDOWN_TIMEOUT from the signal, not SHUTDOWN_TIMEOUT plus the adapter's drain.
    expect(elapsed).toBeGreaterThanOrEqual(1.5);
    expect(elapsed).toBeLessThan(3.5);
    expect((await download).bytes).toBeLessThan(8 * 1024 * 1024);
    expect(socketDirectories(app.temp)).toEqual([]);
  }, 30_000);

  test('shuts down cleanly when SIGTERM arrives while the adapter is still loading', async () => {
    const app = await launch({ STANDIN_LOAD_DELAY_MS: '1500' }, 'none');
    // The public port is bound before the adapter loads; wait for a TCP connect, then signal.
    await waitForPort(app);
    expect(app.output()).not.toContain('standin listening');
    app.proc.kill('SIGTERM');
    const exited = await Promise.race([app.proc.exited, Bun.sleep(8000).then(() => 'timeout')]);
    expect(exited).toBe(0);
    expect(app.output()).toContain('standin drained');
    expect(socketDirectories(app.temp)).toEqual([]);
  }, 20_000);

  test('exits 1 and removes the socket directory on a second signal while the adapter loads', async () => {
    const app = await launch({ STANDIN_LOAD_DELAY_MS: '8000' }, 'none');
    await waitForPort(app);
    app.proc.kill('SIGTERM');
    await Bun.sleep(200);
    app.proc.kill('SIGINT');
    const exited = await Promise.race([app.proc.exited, Bun.sleep(5000).then(() => 'timeout')]);
    expect(exited).toBe(1);
    expect(app.output()).not.toContain('standin listening');
    expect(socketDirectories(app.temp)).toEqual([]);
  }, 20_000);

  test('removes the socket directory when the adapter exits on a second signal', async () => {
    const app = await launch({ SHUTDOWN_TIMEOUT: '10' });
    const response = await fetch(`http://127.0.0.1:${app.port}/sse-open`);
    const body = response.text().catch(() => '');
    expect(socketDirectories(app.temp)).toHaveLength(1);
    app.proc.kill('SIGTERM');
    await Bun.sleep(300);
    // The open stream keeps the adapter draining; its second-signal exit skips sveltekit:shutdown.
    app.proc.kill('SIGTERM');
    const exited = await Promise.race([app.proc.exited, Bun.sleep(5000).then(() => 'timeout')]);
    expect(exited).toBe(1);
    expect(app.output()).not.toContain('standin drained');
    expect(socketDirectories(app.temp)).toEqual([]);
    await body;
  }, 20_000);

  test('exits non-zero and leaves no socket directory when the adapter fails to load', async () => {
    const app = await launch({ STANDIN_THROW: '1' }, 'none');
    expect(await app.proc.exited).not.toBe(0);
    expect(app.output()).toContain('stand-in adapter failed to load');
    expect(socketDirectories(app.temp)).toEqual([]);
    expect(existsSync(app.temp)).toBe(true);
  });
});
