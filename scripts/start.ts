export type LoopbackHost = '127.0.0.1' | '::1';

export function resolveLoopbackHost(value: string | undefined): LoopbackHost {
  const host = value?.trim() || '127.0.0.1';
  if (host === '127.0.0.1' || host === '::1') return host;
  throw new Error('HOST must be 127.0.0.1 or ::1. Non-loopback listeners are not supported.');
}

export async function start(
  environment: Record<string, string | undefined> = process.env,
  importServer: () => Promise<unknown> = () => import(pathToFileURL(resolve('build/index.js')).href)
): Promise<void> {
  environment.HOST = resolveLoopbackHost(environment.HOST);
  await importServer();
}

if (import.meta.main) await start();

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
