import { expect, test } from 'bun:test';
import { OutputDownloader } from '../../../src/lib/server/jobs/downloader';
import { serveVerifiedMediaOutput } from '../../../src/lib/server/media/verified-output';
import type { PoyoStatusResult } from '../../../src/lib/server/poyo/types';
import { createJobFixture } from '../../helpers/job-fixture';

function ebml(type: string): Uint8Array<ArrayBuffer> {
  const value = new TextEncoder().encode(type);
  // A valid EBML header with one DocType element; enough to verify container identification.
  return new Uint8Array([
    0x1a,
    0x45,
    0xdf,
    0xa3,
    0x80 | (3 + value.length),
    0x42,
    0x82,
    0x80 | value.length,
    ...value
  ]);
}
const gif = Uint8Array.from(
  atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
  (value) => value.charCodeAt(0)
);
const publicDns = async () => [{ address: '93.184.216.34', family: 4 as const }];

async function setup(codec: string, fileType: 'image' | 'video', contentType: string) {
  const fixture = await createJobFixture();
  const job = fixture.repository.create({
    actionId: crypto.randomUUID(),
    publicModelId: 'poyo-ai/video-background-removal',
    workflow: 'video-to-video',
    guidedRequest: { outputContainerAndCodec: codec },
    normalizedPayload: {
      model: 'poyo-ai/video-background-removal',
      input: { video_url: 'https://example.com/source.mp4', output_container_and_codec: codec }
    }
  });
  const status: PoyoStatusResult = {
    taskId: 'tool-output',
    statusRaw: 'finished',
    status: 'finished',
    creditsAmount: 1,
    files: [
      {
        url: 'https://media.example/output',
        fileType,
        label: null,
        format: codec,
        contentType,
        fileName: null,
        fileSize: null
      }
    ],
    createdTime: 'now',
    progress: 100,
    errorMessage: null
  };
  fixture.repository.applyStatus(job.id, status, 1000);
  return { fixture, job, output: fixture.repository.outputs(job.id)[0] };
}

test.each([
  ['matroska', 'video/x-matroska', '.mkv'],
  ['webm', 'video/webm', '.webm']
] as const)(
  'verifies EBML DocType %s without conflating MKV and WebM',
  async (docType, contentType, extension) => {
    const { fixture, output } = await setup(
      docType === 'matroska' ? 'mkv_h264' : 'webm_vp9',
      'video',
      contentType
    );
    try {
      if (!output) throw new Error('Missing video output.');
      const downloader = new OutputDownloader({
        repository: fixture.repository,
        paths: fixture.paths,
        resolveHost: publicDns,
        fetch: async () => new Response(ebml(docType), { headers: { 'content-type': contentType } })
      });
      const verified = await downloader.download(output.id);
      expect(verified.mediaKind).toBe('video');
      expect(verified.contentType).toBe(contentType);
      expect(verified.localPath).toEndWith(extension);
      const response = await serveVerifiedMediaOutput(
        new Request('http://localhost/media'),
        fixture.database,
        fixture.paths.media,
        output.id,
        { attachment: true }
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(contentType);
      expect(response.headers.get('content-disposition')).toContain(extension);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(ebml(docType));
      // Reconciliation must accept the published receipt using the same detected container.
      expect((await downloader.download(output.id)).contentType).toBe(contentType);
    } finally {
      await fixture.cleanup();
    }
  }
);

test('rejects a Matroska file mislabeled as WebM and unknown EBML doctypes', async () => {
  for (const type of ['matroska', 'unknown']) {
    const { fixture, output } = await setup('webm_vp9', 'video', 'video/webm');
    try {
      if (!output) throw new Error('Missing output.');
      const downloader = new OutputDownloader({
        repository: fixture.repository,
        paths: fixture.paths,
        resolveHost: publicDns,
        fetch: async () => new Response(ebml(type), { headers: { 'content-type': 'video/webm' } })
      });
      await expect(downloader.download(output.id)).rejects.toThrow();
      expect(fixture.repository.output(output.id)?.downloadState).not.toBe('verified');
    } finally {
      await fixture.cleanup();
    }
  }
});

test.each(['image', 'video'] as const)(
  'stores requested GIF video-tool output as an image with provider file_type=%s',
  async (fileType) => {
    const { fixture, job, output } = await setup('gif', fileType, 'image/gif');
    try {
      if (!output) throw new Error('Missing GIF output.');
      expect(output.mediaKind).toBe('image');
      expect(fixture.repository.get(job.id)?.workflow).toBe('video-to-video');
      const downloader = new OutputDownloader({
        repository: fixture.repository,
        paths: fixture.paths,
        resolveHost: publicDns,
        fetch: async () => new Response(gif, { headers: { 'content-type': 'image/gif' } })
      });
      const verified = await downloader.download(output.id);
      expect(verified.contentType).toBe('image/gif');
      expect(verified.localPath).toEndWith('.gif');
      const response = await serveVerifiedMediaOutput(
        new Request('http://localhost/media'),
        fixture.database,
        fixture.paths.media,
        output.id
      );
      expect(response.headers.get('content-type')).toBe('image/gif');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(gif);
    } finally {
      await fixture.cleanup();
    }
  }
);

test('does not accept a GIF image when a video codec was requested', async () => {
  const { fixture, job, output } = await setup('mp4_h264', 'image', 'image/gif');
  try {
    expect(output).toBeUndefined();
    expect(fixture.repository.get(job.id)?.attentionCode).toBe('malformed_output_set');
  } finally {
    await fixture.cleanup();
  }
});
