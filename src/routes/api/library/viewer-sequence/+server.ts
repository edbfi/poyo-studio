import { randomBytes, randomUUID } from 'node:crypto';
import { createViewerSequenceHandler } from '#lib/server/library/viewer-sequence-handler.js';
import { getPlatformServices } from '#lib/server/platform/runtime.js';
import type { RequestHandler } from './$types';

const tokenContext = {
  secret: randomBytes(32),
  nonce: randomUUID()
};

const handler = createViewerSequenceHandler({
  resolveDatabase: async () => (await getPlatformServices()).database,
  tokenContext
});

export const GET: RequestHandler = handler;
