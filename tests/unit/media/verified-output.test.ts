import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  acceptVerifiedAttachmentRequest,
  authorizeAcceptedAttachmentRequest,
  resolveVerifiedMediaOutput,
  serveVerifiedMediaOutput
} from '../../../src/lib/server/media/verified-output';
import { createJobFixture, createTestJob } from '../../helpers/job-fixture';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function outputFixture() {
  const fixture = await createJobFixture();
  cleanups.push(fixture.cleanup);
  const job = createTestJob(fixture.repository, 'verified-output');
  const outputId = crypto.randomUUID();
  fixture.database
    .query(
      `INSERT INTO job_outputs(id,job_id,output_order,media_kind,download_state,created_at)
       VALUES (?,?,0,'image','pending',?)`
    )
    .run(outputId, job.id, '2026-07-15T12:00:00.000Z');
  return { fixture, job, outputId };
}

describe('verified media output boundary', () => {
  test('resolves only a verified output ID inside a managed media root', async () => {
    const { fixture, outputId } = await outputFixture();
    const path = join(fixture.paths.media, 'job', 'result.png');
    await mkdir(join(fixture.paths.media, 'job'), { recursive: true });
    await writeFile(path, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    await expect(
      resolveVerifiedMediaOutput(fixture.database, fixture.paths.media, outputId)
    ).rejects.toThrow('not available locally');
    fixture.database
      .query(
        "UPDATE job_outputs SET local_path=?,content_type='image/png',download_state='verified' WHERE id=?"
      )
      .run(path, outputId);
    const resolved = await resolveVerifiedMediaOutput(
      fixture.database,
      fixture.paths.media,
      outputId
    );
    expect(resolved).toMatchObject({ outputId, fileName: 'result.png', contentType: 'image/png' });
    expect(resolved.path).toBe(await realpath(path));
  });

  test('rejects missing and outside-root files without exposing their paths', async () => {
    const { fixture, outputId } = await outputFixture();
    const outside = join(dirname(fixture.paths.media), 'private.png');
    await writeFile(outside, 'private');
    fixture.database
      .query("UPDATE job_outputs SET local_path=?,download_state='verified' WHERE id=?")
      .run(outside, outputId);
    let caught: Error | null = null;
    try {
      await resolveVerifiedMediaOutput(fixture.database, fixture.paths.media, outputId);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toBe('This output is not available locally.');
    expect(caught?.message).not.toContain(outside);
  });

  test('serves an attachment with a safe filename and rejects cross-site reads', async () => {
    const { fixture, outputId } = await outputFixture();
    const path = join(fixture.paths.media, 'job', 'result portrait.png');
    await mkdir(join(fixture.paths.media, 'job'), { recursive: true });
    await writeFile(path, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    fixture.database
      .query(
        "UPDATE job_outputs SET local_path=?,content_type='image/png',download_state='verified' WHERE id=?"
      )
      .run(path, outputId);

    const response = await serveVerifiedMediaOutput(
      new Request(`http://127.0.0.1/api/media/${outputId}/download`),
      fixture.database,
      fixture.paths.media,
      outputId,
      { attachment: true }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment;');
    expect(response.headers.get('content-disposition')).toContain('result%20portrait.png');
    expect(response.headers.get('cache-control')).toBe('private, no-store');

    const rejected = await serveVerifiedMediaOutput(
      new Request(`http://127.0.0.1/api/media/${outputId}`, {
        headers: { 'sec-fetch-site': 'cross-site' }
      }),
      fixture.database,
      fixture.paths.media,
      outputId
    );
    expect(rejected.status).toBe(403);
  });

  test('persists only accepted attachment requests and authorizes read-only delivery', async () => {
    const { fixture, job, outputId } = await outputFixture();
    const path = join(fixture.paths.media, 'job', 'accepted.png');
    await mkdir(join(fixture.paths.media, 'job'), { recursive: true });
    await writeFile(path, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    fixture.database
      .query(
        "UPDATE job_outputs SET local_path=?,content_type='image/png',download_state='verified' WHERE id=?"
      )
      .run(path, outputId);

    const requestToken = crypto.randomUUID();
    const request = new Request(`http://127.0.0.1/api/media/${outputId}/download`, {
      method: 'POST'
    });
    const first = await acceptVerifiedAttachmentRequest(
      request,
      fixture.database,
      fixture.paths.media,
      outputId,
      requestToken
    );
    const replay = await acceptVerifiedAttachmentRequest(
      request,
      fixture.database,
      fixture.paths.media,
      outputId,
      requestToken
    );

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ requestedAt: first.requestedAt, replayed: true });
    expect(
      fixture.database
        .query<{ count: number }, []>('SELECT COUNT(*) count FROM attachment_requests')
        .get()?.count
    ).toBe(1);

    authorizeAcceptedAttachmentRequest(request, fixture.database, outputId, requestToken);
    authorizeAcceptedAttachmentRequest(request, fixture.database, outputId, requestToken);
    expect(
      fixture.database
        .query<{ count: number }, []>('SELECT COUNT(*) count FROM attachment_requests')
        .get()?.count
    ).toBe(1);
    const attachmentUrl = `http://127.0.0.1/api/media/${outputId}/download?request=${requestToken}`;
    const ranged = await serveVerifiedMediaOutput(
      new Request(attachmentUrl, { headers: { range: 'bytes=1-2' } }),
      fixture.database,
      fixture.paths.media,
      outputId,
      { attachment: true }
    );
    const head = await serveVerifiedMediaOutput(
      new Request(attachmentUrl, { method: 'HEAD' }),
      fixture.database,
      fixture.paths.media,
      outputId,
      { attachment: true, head: true }
    );
    expect(ranged.status).toBe(206);
    expect(await ranged.arrayBuffer()).toHaveLength(2);
    expect(head.status).toBe(200);
    expect(await head.arrayBuffer()).toHaveLength(0);
    const invalidRangeHead = await serveVerifiedMediaOutput(
      new Request(attachmentUrl, { method: 'HEAD', headers: { range: 'bytes=99-100' } }),
      fixture.database,
      fixture.paths.media,
      outputId,
      { attachment: true, head: true }
    );
    expect(invalidRangeHead.status).toBe(416);
    expect(invalidRangeHead.body).toBeNull();
    expect(
      fixture.database
        .query<{ count: number }, []>('SELECT COUNT(*) count FROM attachment_requests')
        .get()?.count
    ).toBe(1);
    expect(() =>
      authorizeAcceptedAttachmentRequest(request, fixture.database, outputId, crypto.randomUUID())
    ).toThrow();

    const otherOutputId = crypto.randomUUID();
    fixture.database
      .query(
        `INSERT INTO job_outputs(
           id,job_id,output_order,media_kind,local_path,content_type,download_state,created_at
         ) VALUES (?,?,1,'image',?,'image/png','verified',?)`
      )
      .run(otherOutputId, job.id, path, '2026-07-15T12:00:00.000Z');
    await expect(
      acceptVerifiedAttachmentRequest(
        request,
        fixture.database,
        fixture.paths.media,
        otherOutputId,
        requestToken
      )
    ).rejects.toMatchObject({
      code: 'request_output_mismatch',
      status: 409
    });
    const unavailableOutputId = crypto.randomUUID();
    fixture.database
      .query(
        `INSERT INTO job_outputs(id,job_id,output_order,media_kind,download_state,created_at)
         VALUES (?,?,2,'image','pending',?)`
      )
      .run(unavailableOutputId, job.id, '2026-07-15T12:00:00.000Z');
    const unavailableHead = await serveVerifiedMediaOutput(
      new Request(`http://127.0.0.1/api/media/${unavailableOutputId}`, { method: 'HEAD' }),
      fixture.database,
      fixture.paths.media,
      unavailableOutputId,
      { head: true }
    );
    expect(unavailableHead.status).toBe(404);
    expect(unavailableHead.body).toBeNull();
    await expect(
      acceptVerifiedAttachmentRequest(
        request,
        fixture.database,
        fixture.paths.media,
        unavailableOutputId,
        crypto.randomUUID()
      )
    ).rejects.toMatchObject({ status: 404 });
    expect(
      fixture.database
        .query<{ count: number }, []>('SELECT COUNT(*) count FROM attachment_requests')
        .get()?.count
    ).toBe(1);
  });
});

test('serves a verified SVG as an image with sandbox protection for preview and download', async () => {
  const { fixture, outputId } = await outputFixture();
  const path = join(fixture.paths.media, 'vector.svg');
  await mkdir(fixture.paths.media, { recursive: true });
  await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>');
  fixture.database
    .query(
      "UPDATE job_outputs SET local_path=?,content_type='image/svg+xml',download_state='verified' WHERE id=?"
    )
    .run(path, outputId);
  for (const attachment of [false, true]) {
    const response = await serveVerifiedMediaOutput(
      new Request(`http://localhost/api/media/${outputId}`),
      fixture.database,
      fixture.paths.media,
      outputId,
      { attachment }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(response.headers.get('content-security-policy')).toContain('sandbox;');
    expect(response.headers.get('content-disposition')?.startsWith('attachment')).toBe(
      attachment ? true : undefined
    );
  }
});
