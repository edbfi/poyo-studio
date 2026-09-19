import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobFiltersDto, LibraryFiltersDto } from '../../../src/lib/features/library/contracts';
import { JOB_EVENT_METADATA_KEY } from '../../../src/lib/server/jobs/event-attention';
import type {
  ViewerSequenceQueryObservation,
  ViewerSequenceTokenContext
} from '../../../src/lib/server/library/repository';
import {
  LibraryRepository,
  projectSafeConfiguration
} from '../../../src/lib/server/library/repository';
import { seedImageRegistry } from '../../../src/lib/server/registry/repository';
import { createJobFixture } from '../../helpers/job-fixture';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

const jobs: JobFiltersDto = {
  status: 'all',
  q: '',
  model: '',
  workflow: '',
  dateFrom: '',
  dateTo: '',
  cursor: ''
};
const library: LibraryFiltersDto = {
  q: '',
  mediaKind: '',
  model: '',
  provider: '',
  workflow: '',
  aspectRatio: '',
  status: 'all',
  favorite: false,
  tag: '',
  dateFrom: '',
  dateTo: '',
  cursor: '',
  view: 'grid'
};

async function completedGeneration(suffix: string, prompt = `calm coast ${suffix}`) {
  const fixture = await createJobFixture();
  cleanups.push(fixture.cleanup);
  seedImageRegistry(fixture.database);
  const job = fixture.repository.create({
    actionId: crypto.randomUUID(),
    entryKey: 'flux-schnell:text-to-image',
    workflow: 'text-to-image',
    publicModelId: 'flux-schnell',
    guidedRequest: { prompt, aspectRatio: '1:1' },
    normalizedPayload: { model: 'flux-schnell', input: { prompt } },
    prompt,
    correlationId: `correlation-${suffix}`
  });
  fixture.repository.applyStatus(
    job.id,
    {
      taskId: `task-${suffix}`,
      statusRaw: 'finished',
      status: 'finished',
      creditsAmount: 3,
      files: [
        {
          url: `https://cdn.poyo.test/${suffix}.png`,
          fileType: 'image',
          label: null,
          format: 'png',
          contentType: 'image/png',
          fileName: `${suffix}.png`,
          fileSize: 12
        }
      ],
      createdTime: 'now',
      progress: 100,
      errorMessage: null
    },
    1000
  );
  const output = fixture.repository.outputs(job.id)[0];
  if (!output) throw new Error('Expected a fixture output.');
  const localPath = join(fixture.paths.media, job.id, `${suffix}.png`);
  await mkdir(join(fixture.paths.media, job.id), { recursive: true });
  await writeFile(localPath, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  const attempt = fixture.repository.startDownload(output.id);
  fixture.repository.verifyDownload(output.id, attempt, {
    path: localPath,
    size: 4,
    checksum: 'checksum',
    signature: '89504e47',
    contentType: 'image/png',
    pixelWidth: 1080,
    pixelHeight: 1920,
    aspectRatio: '9:16'
  });
  fixture.repository.finishIfDownloaded(job.id);
  return { fixture, job, output, localPath };
}

describe('server-side jobs and grouped library repository', () => {
  test('keeps the poll failure domain authoritative without widening list DTOs', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    seedImageRegistry(fixture.database);
    const job = fixture.repository.create({
      actionId: crypto.randomUUID(),
      entryKey: 'flux-schnell:text-to-image',
      workflow: 'text-to-image',
      publicModelId: 'flux-schnell',
      guidedRequest: { prompt: 'poll-blocked fixture' },
      normalizedPayload: { model: 'flux-schnell', input: { prompt: 'poll-blocked fixture' } }
    });
    const claim = fixture.repository.claimSubmission(job.id, 'test', 1_000);
    if (!claim) throw new Error('Expected a submission claim.');
    expect(
      fixture.repository.acknowledgeSubmission(job.id, claim.token, {
        taskId: 'task-poll-blocked-fixture',
        statusRaw: 'not_started',
        status: 'not_started',
        createdTime: 'now'
      })
    ).toBe(true);
    fixture.repository.recordPollBlocked(job.id, 'public_ipv4_guard_unavailable');

    const item = new LibraryRepository(fixture.database).listJobs(
      { ...jobs, status: 'attention' },
      1
    ).items[0];
    expect(item).toMatchObject({
      failureDomain: 'poll',
      attentionCode: 'ip_guard_blocked',
      ipGuardReason: 'unavailable'
    });
    expect(item).not.toHaveProperty('poyoTaskId');
  });

  test('filters, paginates and groups outputs without exposing local paths', async () => {
    const fullPrompt = [
      'calm coast first with a complete persisted prompt',
      'A second line proves that prompt formatting survives the detail data path.',
      `Unbroken containment token: ${'cobalt'.repeat(120)}`
    ].join('\n');
    const { fixture, job } = await completedGeneration('first', fullPrompt);
    const repository = new LibraryRepository(fixture.database);
    const jobPage = repository.listJobs({ ...jobs, status: 'completed', q: 'coast' }, 1);
    expect(jobPage.total).toBe(1);
    expect(jobPage.items[0]).toMatchObject({
      id: job.id,
      displayName: 'Flux Schnell',
      outputCount: 1,
      verifiedOutputCount: 1,
      promptExcerpt: fullPrompt.slice(0, 220)
    });

    const mediaPage = repository.listLibrary({ ...library, mediaKind: 'image' }, 1);
    expect(mediaPage.total).toBe(1);
    expect(mediaPage.items[0]).toMatchObject({
      jobId: job.id,
      outputCount: 1,
      promptExcerpt: fullPrompt.slice(0, 220)
    });
    expect(mediaPage.items[0]?.representative).toMatchObject({
      mediaUrl: expect.stringMatching(/^\/api\/media\//),
      pixelWidth: 1080,
      pixelHeight: 1920
    });

    const detail = await repository.getJobDetail(job.id);
    expect(detail?.prompt).toBe(fullPrompt);
    expect(detail?.outputs[0]).toMatchObject({
      localAvailable: true,
      fileName: 'first.png',
      pixelWidth: 1080,
      pixelHeight: 1920,
      aspectRatio: '9:16'
    });
    expect(detail?.outputs[0]).not.toHaveProperty('localPath');
    expect(await repository.storageStatistics(fixture.paths)).toMatchObject({
      indexedBytes: 4,
      verifiedFiles: 1,
      missingOrDeletedFiles: 0
    });
  });

  test('persists grouping metadata and applies explicit local deletion consequences', async () => {
    const { fixture, job, output, localPath } = await completedGeneration('organize');
    const repository = new LibraryRepository(fixture.database);
    repository.setFavorite(job.id, true);
    repository.setPinned(job.id, true);
    expect(repository.replaceTags(job.id, ['Landscape', ' landscape ', 'Pinned'])).toEqual([
      'Pinned',
      'landscape'
    ]);
    expect(
      repository.listLibrary({ ...library, favorite: true, tag: 'landscape' }).items[0]
    ).toMatchObject({ favorite: true, pinned: true, tags: ['Pinned', 'landscape'] });

    fixture.database
      .query('UPDATE jobs SET attention_code=? WHERE id=?')
      .run('public_ipv4_guard_match', job.id);

    await repository.deleteOutput(job.id, output.id, 'file', fixture.paths);
    expect(await Bun.file(localPath).exists()).toBe(false);
    expect((await repository.getJobDetail(job.id))?.outputs[0]).toMatchObject({
      downloadState: 'deleted',
      localAvailable: false
    });
    const storedEvent = fixture.database
      .query<{ safe_payload_json: string }, [string, string]>(
        'SELECT safe_payload_json FROM job_events WHERE job_id=? AND event_type=?'
      )
      .get(job.id, 'output.local_file_removed');
    expect(JSON.parse(storedEvent?.safe_payload_json ?? '{}')).toEqual({
      outputId: output.id,
      [JOB_EVENT_METADATA_KEY]: {
        version: 1,
        attentionCode: 'public_ipv4_guard_match',
        payloadWasNull: false
      }
    });
    const outwardEvent = (await repository.getJobDetail(job.id))?.history.find(
      (event) => event.eventType === 'output.local_file_removed'
    );
    expect(outwardEvent).not.toHaveProperty('payload');
    expect(JSON.stringify(outwardEvent)).not.toContain(JOB_EVENT_METADATA_KEY);
    expect(JSON.stringify(outwardEvent)).not.toContain('public_ipv4_guard_match');
  });

  test('refuses to mark an output deleted when its file is outside managed media storage', async () => {
    const { fixture, job, output, localPath } = await completedGeneration('orphan-guard');
    const repository = new LibraryRepository(fixture.database);
    const foreign = `${fixture.paths.media}-foreign`;
    const strandedPaths = { ...fixture.paths, media: foreign };
    await expect(repository.deleteOutput(job.id, output.id, 'file', strandedPaths)).rejects.toThrow(
      /managed media storage/
    );
    // Must not report success: the file stays and the DB row is left untouched (no false "deleted").
    expect(await Bun.file(localPath).exists()).toBe(true);
    expect((await repository.getJobDetail(job.id))?.outputs[0]).toMatchObject({
      downloadState: 'verified',
      localAvailable: true
    });
  });

  test('preserves safe original-to-neutral source provenance without raw storage details', async () => {
    const { fixture, job } = await completedGeneration('managed-source');
    const sourceId = crypto.randomUUID();
    const relativePath = `2026-07/${sourceId}.png`;
    const localPath = join(fixture.paths.uploads, relativePath);
    await mkdir(join(fixture.paths.uploads, '2026-07'), { recursive: true });
    await writeFile(localPath, new Uint8Array(8).fill(1));
    fixture.database
      .query(
        `INSERT INTO managed_sources(id,original_name,media_kind,mime_type,byte_size,checksum,signature,relative_path,availability,created_at,last_verified_at)
         VALUES (?,?,?,?,?,?,?,?, 'available',?,?)`
      )
      .run(
        sourceId,
        'original-source-name.png',
        'image',
        'image/png',
        8,
        'source-checksum',
        '89504e47',
        relativePath,
        '2026-07-15T12:00:00.000Z',
        '2026-07-15T12:00:00.000Z'
      );
    fixture.database
      .query(
        `INSERT INTO job_inputs(job_id,role,input_order,media_kind,upload_url,metadata_json,availability,managed_source_id)
         VALUES (?, 'source-image', 0, 'image', 'https://poyo.test/source.png', '{}', 'available', ?)`
      )
      .run(job.id, sourceId);
    const repository = new LibraryRepository(fixture.database);
    expect(await repository.storageStatistics(fixture.paths)).toMatchObject({
      indexedBytes: 12,
      verifiedFiles: 2,
      generatedBytes: 4,
      managedSourceBytes: 8,
      managedSourceFiles: 1,
      missingOrDeletedSources: 0
    });

    await unlink(localPath);
    expect(await repository.storageStatistics(fixture.paths)).toMatchObject({
      indexedBytes: 4,
      verifiedFiles: 1,
      missingOrDeletedFiles: 1,
      managedSourceBytes: 0,
      managedSourceFiles: 0,
      missingOrDeletedSources: 1
    });
    const detail = await repository.getJobDetail(job.id);
    expect(detail?.inputs[0]).toMatchObject({
      sourceKind: 'local',
      sourceLabel: 'original-source-name.png',
      originalName: 'original-source-name.png',
      neutralUploadName: `${sourceId}.png`,
      availability: 'missing',
      localConsequence: 'missing',
      byteSize: 8
    });
    expect(detail?.inputs[0]).not.toHaveProperty('checksum');
    expect(detail?.inputs[0]).not.toHaveProperty('managedSourceId');
    expect(detail?.inputs[0]).not.toHaveProperty('localPath');
  });

  test('history strips durable attention metadata and redacts raw policy codes', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    seedImageRegistry(fixture.database);
    const job = fixture.repository.create({
      actionId: crypto.randomUUID(),
      entryKey: 'flux-schnell:text-to-image',
      workflow: 'text-to-image',
      publicModelId: 'flux-schnell',
      guidedRequest: { prompt: 'safe event history' },
      normalizedPayload: { model: 'flux-schnell', input: { prompt: 'safe event history' } }
    });
    fixture.repository.transition(
      job.id,
      'requires_attention',
      'poll',
      'public_ipv4_guard_match',
      'poll.policy_blocked',
      { code: 'public_ipv4_guard_match', marker: 'retained' }
    );
    fixture.repository.transition(
      job.id,
      'requires_attention',
      'submission',
      'submission_unknown',
      'submission.unknown'
    );
    fixture.database
      .query(
        `INSERT INTO job_events(job_id,event_type,local_phase,remote_status_raw,remote_status,failure_domain,progress,safe_payload_json,observed_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        job.id,
        'malformed.metadata',
        'requires_attention',
        null,
        'unknown',
        'submission',
        null,
        JSON.stringify({
          marker: 'malformed',
          [JOB_EVENT_METADATA_KEY]: { version: 'invalid', payloadWasNull: false }
        }),
        '2026-07-15T12:00:01.000Z'
      );

    const history = (await new LibraryRepository(fixture.database).getJobDetail(job.id))?.history;
    expect(history?.every((event) => !('payload' in event))).toBe(true);
    expect(history?.every((event) => !('remoteStatusRaw' in event))).toBe(true);
    expect(JSON.stringify(history)).not.toContain(JOB_EVENT_METADATA_KEY);
    expect(JSON.stringify(history)).not.toContain('public_ipv4_guard_match');
  });
  test('resolves safe image neighbors by immutable creation chronology', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    seedImageRegistry(fixture.database);

    async function createGeneration(
      suffix: string,
      createdAt: string,
      mediaKind: 'image' | 'video',
      availability: 'pending' | 'failed' | 'ready' | 'missing'
    ) {
      fixture.setNow(new Date(createdAt));
      const job = fixture.repository.create({
        actionId: crypto.randomUUID(),
        entryKey:
          mediaKind === 'image'
            ? 'flux-schnell:text-to-image'
            : 'wan2.7-image-to-video:image-to-video',
        workflow: mediaKind === 'image' ? 'text-to-image' : 'image-to-video',
        publicModelId: mediaKind === 'image' ? 'flux-schnell' : 'wan2.7-image-to-video',
        guidedRequest: { prompt: suffix },
        normalizedPayload: { model: suffix, input: { prompt: suffix } },
        prompt: suffix,
        correlationId: `correlation-${suffix}`
      });
      if (availability === 'pending') return { job, output: null, localPath: null };

      fixture.repository.applyStatus(
        job.id,
        {
          taskId: `task-${suffix}`,
          statusRaw: 'finished',
          status: 'finished',
          creditsAmount: 1,
          files: [
            {
              url: `https://cdn.poyo.test/${suffix}.${mediaKind === 'image' ? 'png' : 'mp4'}`,
              fileType: mediaKind,
              label: null,
              format: mediaKind === 'image' ? 'png' : 'mp4',
              contentType: mediaKind === 'image' ? 'image/png' : 'video/mp4',
              fileName: `${suffix}.${mediaKind === 'image' ? 'png' : 'mp4'}`,
              fileSize: 4
            }
          ],
          createdTime: createdAt,
          progress: 100,
          errorMessage: null
        },
        1000
      );
      const output = fixture.repository.outputs(job.id)[0];
      if (!output) throw new Error('Expected a fixture output.');
      if (availability === 'failed') {
        fixture.database
          .query("UPDATE job_outputs SET download_state='failed' WHERE id=?")
          .run(output.id);
        return { job, output, localPath: null };
      }

      const directory = join(fixture.paths.media, job.id);
      const localPath = join(directory, `${suffix}.${mediaKind === 'image' ? 'png' : 'mp4'}`);
      await mkdir(directory, { recursive: true });
      await writeFile(localPath, new Uint8Array([1, 2, 3, 4]));
      const attempt = fixture.repository.startDownload(output.id);
      fixture.repository.verifyDownload(output.id, attempt, {
        path: localPath,
        size: 4,
        checksum: `checksum-${suffix}`,
        signature: mediaKind === 'image' ? '89504e47' : '00000018',
        contentType: mediaKind === 'image' ? 'image/png' : 'video/mp4',
        pixelWidth: 64,
        pixelHeight: 64,
        aspectRatio: '1:1'
      });
      fixture.repository.finishIfDownloaded(job.id);
      if (availability === 'missing') await unlink(localPath);
      return { job, output, localPath };
    }

    const first = await createGeneration('first', '2026-07-15T12:00:00.000Z', 'image', 'ready');
    await createGeneration('failed', '2026-07-15T12:01:00.000Z', 'image', 'failed');
    await createGeneration('video', '2026-07-15T12:02:00.000Z', 'video', 'ready');
    const current = await createGeneration(
      'current-pending',
      '2026-07-15T12:03:00.000Z',
      'image',
      'pending'
    );
    const tieA = await createGeneration('tie-a', '2026-07-15T12:04:00.000Z', 'image', 'ready');
    const tieB = await createGeneration('tie-b', '2026-07-15T12:04:00.000Z', 'image', 'ready');
    await createGeneration('missing', '2026-07-15T12:05:00.000Z', 'image', 'missing');
    const last = await createGeneration('last', '2026-07-15T12:06:00.000Z', 'image', 'ready');

    const repository = new LibraryRepository(fixture.database);
    const tieOrder = [tieA.job.id, tieB.job.id].toSorted();
    const tieFirst = tieOrder[0];
    const tieSecond = tieOrder[1];
    if (!tieFirst || !tieSecond) throw new Error('Expected two tie fixtures.');
    expect(await repository.getImageNavigation(current.job.id, fixture.paths.media)).toEqual({
      previous: expect.objectContaining({ jobId: first.job.id }),
      next: expect.objectContaining({ jobId: tieFirst })
    });
    expect(await repository.getImageNavigation(tieFirst, fixture.paths.media)).toEqual({
      previous: expect.objectContaining({ jobId: first.job.id }),
      next: expect.objectContaining({ jobId: tieSecond })
    });
    expect(await repository.getImageNavigation(tieSecond, fixture.paths.media)).toEqual({
      previous: expect.objectContaining({ jobId: tieFirst }),
      next: expect.objectContaining({ jobId: last.job.id })
    });
    expect(await repository.getImageNavigation(first.job.id, fixture.paths.media)).toEqual({
      previous: null,
      next: expect.objectContaining({ jobId: tieFirst })
    });
    expect(await repository.getImageNavigation(last.job.id, fixture.paths.media)).toEqual({
      previous: expect.objectContaining({ jobId: tieSecond }),
      next: null
    });

    const removedTie = tieA.job.id === tieFirst ? tieA : tieB;
    if (!removedTie.output) throw new Error('Expected a ready tie output.');
    fixture.database
      .query("UPDATE job_outputs SET download_state='deleted',local_path=NULL WHERE id=?")
      .run(removedTie.output.id);
    const remainingTie = removedTie.job.id === tieA.job.id ? tieB.job.id : tieA.job.id;
    expect(
      (await repository.getImageNavigation(current.job.id, fixture.paths.media))?.next?.jobId
    ).toBe(remainingTie);
  });
});
describe('safe library activity projections', () => {
  test('projects only the fixed-order configuration grammar without evaluating accessors', () => {
    const source = Object.assign(Object.create({ width: 1024 }), {
      outputCount: 100,
      promptStrength: 0,
      guidanceScale: 100,
      steps: 1000,
      seed: 4_294_967_295,
      frames: 1_000_000,
      fps: 240,
      duration: 3600,
      height: 32768,
      width: 1,
      resolution: '8K',
      size: '32768x32768',
      aspectRatio: '1:1',
      ignored: 'raw-record-canary',
      prompt: '<script>raw-record-canary</script>'
    });
    const getterCanary = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(getterCanary, 'fps', {
      enumerable: true,
      get() {
        throw new Error('Configuration accessors must not run.');
      }
    });

    expect(projectSafeConfiguration(getterCanary)).toEqual([]);
    expect(projectSafeConfiguration(source)).toEqual([
      { key: 'aspectRatio', label: 'Aspect ratio', value: '1:1' },
      { key: 'size', label: 'Size', value: '32768x32768' },
      { key: 'resolution', label: 'Resolution', value: '8K' },
      { key: 'width', label: 'Width', value: '1' },
      { key: 'height', label: 'Height', value: '32768' },
      { key: 'duration', label: 'Duration', value: '3600' },
      { key: 'fps', label: 'FPS', value: '240' },
      { key: 'frames', label: 'Frames', value: '1000000' },
      { key: 'seed', label: 'Seed', value: '4294967295' },
      { key: 'steps', label: 'Steps', value: '1000' },
      { key: 'guidanceScale', label: 'Guidance scale', value: '100' },
      { key: 'promptStrength', label: 'Prompt strength', value: '0' },
      { key: 'outputCount', label: 'Output count', value: '100' }
    ]);
    expect(
      projectSafeConfiguration({
        width: 1,
        height: 32768,
        duration: 0.1,
        fps: 1,
        frames: 1,
        seed: 0,
        steps: 1,
        guidanceScale: 0,
        promptStrength: 1,
        outputCount: 1
      })
    ).toEqual([
      { key: 'width', label: 'Width', value: '1' },
      { key: 'height', label: 'Height', value: '32768' },
      { key: 'duration', label: 'Duration', value: '0.1' },
      { key: 'fps', label: 'FPS', value: '1' },
      { key: 'frames', label: 'Frames', value: '1' },
      { key: 'seed', label: 'Seed', value: '0' },
      { key: 'steps', label: 'Steps', value: '1' },
      { key: 'guidanceScale', label: 'Guidance scale', value: '0' },
      { key: 'promptStrength', label: 'Prompt strength', value: '1' },
      { key: 'outputCount', label: 'Output count', value: '1' }
    ]);
    expect(JSON.stringify(projectSafeConfiguration(source))).not.toContain('raw-record-canary');

    expect(
      projectSafeConfiguration({
        aspectRatio: '1:1<script>',
        size: '32769x1',
        resolution: 'FHD ',
        width: 0,
        height: 32769,
        duration: 0.099,
        fps: 240.1,
        frames: 1.5,
        seed: -0,
        steps: Number.POSITIVE_INFINITY,
        guidanceScale: '0',
        promptStrength: null,
        outputCount: true
      })
    ).toEqual([]);
    expect(projectSafeConfiguration(null)).toEqual([]);
    expect(projectSafeConfiguration([])).toEqual([]);
  });

  test('projects ordered activity costs and safe DTOs without a balance currency fallback', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const insertJob = fixture.database.query(
      `INSERT INTO jobs(
        id,workflow,public_model_id,local_phase,remote_status,failure_domain,
        guided_request_json,actual_payload_json,estimated_credits,actual_credits,last_polled_at,prompt_text,
        search_text,correlation_id,created_at,updated_at
      ) VALUES (?,?,?,'complete','finished','none','{}','{}',?,?,?,?,?,?,?,?)`
    );
    const insertOutput = fixture.database.query(
      `INSERT INTO job_outputs(
        id,job_id,output_order,media_kind,local_path,download_state,favorite,pinned,created_at
      ) VALUES (?, ?, 0, 'image', ?, 'verified', 0, 0, ?)`
    );
    const insertAttachment = fixture.database.query(
      'INSERT INTO attachment_requests(id,request_token,job_output_id,requested_at) VALUES (?,?,?,?)'
    );
    const insertCreatedEvent = fixture.database.query(
      `INSERT INTO job_events(
        job_id,event_type,local_phase,remote_status,failure_domain,safe_payload_json,observed_at
      ) VALUES (?, 'job.created', 'complete', 'finished', 'none', ?, ?)`
    );
    fixture.database.transaction(() => {
      insertJob.run(
        'activity-charge-job',
        'text-to-image',
        'flux-schnell',
        null,
        0,
        '2026-07-15T12:00:00.000Z',
        'charge activity',
        'charge activity',
        'activity-charge',
        '2026-07-15T12:00:00.000Z',
        '2026-07-15T12:00:00.000Z'
      );
      insertOutput.run(
        'activity-charge-output',
        'activity-charge-job',
        '/private/charge-output.png',
        '2026-07-15T12:00:00.000Z'
      );
      insertAttachment.run(
        'activity-charge-attachment',
        crypto.randomUUID(),
        'activity-charge-output',
        '2026-07-15T12:00:00.000Z'
      );

      insertJob.run(
        'activity-estimate-job',
        'text-to-image',
        'flux-schnell',
        2.5,
        null,
        null,
        'estimate activity',
        'estimate activity',
        'activity-estimate',
        '2026-07-15T11:00:00.000Z',
        '2026-07-15T11:00:00.000Z'
      );
      insertCreatedEvent.run(
        'activity-estimate-job',
        JSON.stringify({
          estimate: {
            credits: 2.5,
            signature: 'safe-estimate',
            provenance: 'observed',
            sourceVerifiedAt: '2026-07-20T00:00:00.000Z'
          }
        }),
        '2026-07-15T11:00:00.000Z'
      );

      insertJob.run(
        'activity-unavailable-job',
        'text-to-image',
        'flux-schnell',
        4,
        null,
        null,
        'unavailable activity',
        'unavailable activity',
        'activity-unavailable',
        '2026-07-14T10:00:00.000Z',
        '2026-07-14T10:00:00.000Z'
      );
      insertOutput.run(
        'activity-unavailable-output',
        'activity-unavailable-job',
        '/private/unavailable-output.png',
        '2026-07-14T10:00:00.000Z'
      );
      insertAttachment.run(
        'activity-later-attachment',
        crypto.randomUUID(),
        'activity-unavailable-output',
        '2026-07-16T10:00:00.000Z'
      );
    })();

    const repository = new LibraryRepository(fixture.database);
    const firstPage = repository.listActivities(jobs, 2);
    const firstCursor = firstPage.nextCursor;
    expect(firstPage).toMatchObject({ total: 5, nextCursor: expect.any(String) });
    expect(firstPage.items).toMatchObject([
      {
        kind: 'attachment-request',
        id: 'activity-later-attachment',
        occurredAt: '2026-07-16T10:00:00.000Z',
        fileName: 'unavailable-output.png',
        cost: null
      },
      {
        kind: 'job-created',
        id: 'activity-charge-job',
        occurredAt: '2026-07-15T12:00:00.000Z',
        cost: {
          kind: 'charge',
          credits: 0,
          terminalStatus: 'finished',
          settledAt: '2026-07-15T12:00:00.000Z'
        }
      }
    ]);
    expect(JSON.stringify(firstPage.items)).not.toContain('/private/');

    if (!firstCursor) throw new Error('Expected an activity pagination cursor.');
    const canonicalCursor = JSON.parse(atob(firstCursor)) as Record<string, unknown>;
    for (const occurredAt of ['2026-07-15T13:00:00+01:00', '2026-07-15T12:00:00Z']) {
      const nonCanonicalCursor = { ...canonicalCursor, occurredAt };
      expect(
        repository
          .listActivities({ ...jobs, cursor: btoa(JSON.stringify(nonCanonicalCursor)) }, 2)
          .items.map((item) => item.id)
      ).toEqual(firstPage.items.map((item) => item.id));
    }

    const secondPage = repository.listActivities({ ...jobs, cursor: firstCursor ?? '' }, 3);
    expect(secondPage).toMatchObject({
      total: 5,
      nextCursor: null,
      items: [
        {
          kind: 'attachment-request',
          id: 'activity-charge-attachment',
          cost: null
        },
        {
          kind: 'job-created',
          id: 'activity-estimate-job',
          cost: {
            kind: 'estimate',
            credits: 2.5,
            provenance: 'observed',
            sourceVerifiedAt: '2026-07-20T00:00:00.000Z'
          }
        },
        {
          kind: 'job-created',
          id: 'activity-unavailable-job',
          cost: { kind: 'unavailable' }
        }
      ]
    });
    expect(repository.listActivities({ ...jobs, dateFrom: '2026-07-16' }).items).toMatchObject([
      { kind: 'attachment-request', id: 'activity-later-attachment' }
    ]);
    expect(repository.listActivities({ ...jobs, q: 'charge' }).total).toBe(2);
  });
});

function viewerFilters(): Omit<LibraryFiltersDto, 'cursor' | 'view'> {
  const { cursor: _cursor, view: _view, ...filters } = library;
  return filters;
}

async function viewerSequenceFixture(count: number) {
  const fixture = await createJobFixture();
  cleanups.push(fixture.cleanup);
  const insertJob = fixture.database.query(
    `INSERT INTO jobs(
      id,workflow,public_model_id,local_phase,remote_status,failure_domain,
      guided_request_json,actual_payload_json,prompt_text,search_text,correlation_id,
      created_at,updated_at,completed_at
    ) VALUES (?,?,?,'complete','finished','none',?,?,?,?,?,?,?,?)`
  );
  const insertOutput = fixture.database.query(
    `INSERT INTO job_outputs(
      id,job_id,output_order,media_kind,remote_url,local_path,content_type,byte_size,
      download_state,favorite,pinned,created_at,verified_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  fixture.database.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const id = `viewer-job-${index.toString().padStart(3, '0')}`;
      const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(index / 2))).toISOString();
      const kind = index % 2 ? 'video' : 'image';
      insertJob.run(
        id,
        kind === 'video' ? 'text-to-video' : 'text-to-image',
        kind === 'video' ? 'grok-imagine-video' : 'flux-schnell',
        JSON.stringify({ prompt: `viewer ${index}`, aspectRatio: index % 2 ? '16:9' : '1:1' }),
        JSON.stringify({}),
        `viewer ${index}`,
        `viewer ${index}`,
        `viewer-${index}`,
        createdAt,
        createdAt,
        createdAt
      );
      // An unavailable non-favorite output must not displace the verified representative.
      insertOutput.run(
        `viewer-deleted-${index}`,
        id,
        0,
        kind,
        'https://example.test/deleted',
        null,
        kind === 'video' ? 'video/mp4' : 'image/png',
        1,
        'deleted',
        0,
        0,
        createdAt,
        null
      );
      insertOutput.run(
        `viewer-output-${index}`,
        id,
        1,
        kind,
        `https://example.test/${index}`,
        `/media/${id}`,
        kind === 'video' ? 'video/mp4' : 'image/png',
        1,
        'verified',
        index % 3 === 0 ? 1 : 0,
        0,
        createdAt,
        createdAt
      );
    }
  })();
  return fixture;
}

describe('indexed viewer sequence repository', () => {
  const tokenContext: ViewerSequenceTokenContext = {
    secret: new TextEncoder().encode('viewer-sequence-test-secret'),
    nonce: 'test-process-nonce'
  };

  test('uses strict N+1 lookahead and exact initial/intermediate/terminal phases', async () => {
    const fixture = await viewerSequenceFixture(5);
    const observations: ViewerSequenceQueryObservation[] = [];
    const repository = new LibraryRepository(fixture.database);
    const first = repository.listViewerSequence(
      viewerFilters(),
      null,
      null,
      2,
      tokenContext,
      (item) => observations.push(item)
    );
    expect(first.items.map((item) => item.jobId)).toEqual(['viewer-job-004', 'viewer-job-003']);
    expect(first.items.map((item) => item.outputId)).toEqual([
      'viewer-output-4',
      'viewer-output-3'
    ]);
    expect(first.total).toBe(5);
    expect(first.nextCursor).not.toBeNull();
    expect(observations.filter((item) => item.operation === 'count')).toHaveLength(1);
    expect(observations.find((item) => item.operation === 'page-seek')?.rows).toBe(3);
    expect(observations.find((item) => item.operation === 'page-hydrate')?.rows).toBe(2);

    const middle = repository.listViewerSequence(
      viewerFilters(),
      first.nextCursor,
      first.snapshot,
      2,
      tokenContext,
      (item) => observations.push(item)
    );
    expect(middle.items.map((item) => item.jobId)).toEqual(['viewer-job-002', 'viewer-job-001']);
    expect(middle.total).toBeNull();
    expect(middle.nextCursor).not.toBeNull();

    const terminal = repository.listViewerSequence(
      viewerFilters(),
      middle.nextCursor,
      middle.snapshot,
      2,
      tokenContext,
      (item) => observations.push(item)
    );
    expect(terminal.items.map((item) => item.jobId)).toEqual(['viewer-job-000']);
    expect(terminal.nextCursor).toBeNull();
    expect(terminal.total).toBe(5);
    expect(observations.filter((item) => item.operation === 'count')).toHaveLength(2);
  });
  test('excludes a job whose canonical favorite is unavailable instead of substituting a verified output', async () => {
    const fixture = await viewerSequenceFixture(3);
    const repository = new LibraryRepository(fixture.database);
    fixture.database.query('UPDATE job_outputs SET favorite=1 WHERE id=?').run('viewer-deleted-1');

    const grid = repository.listLibrary(library, 24);
    const unavailable = grid.items.find((item) => item.jobId === 'viewer-job-001');
    expect(unavailable?.representative).toMatchObject({
      outputId: 'viewer-deleted-1',
      downloadState: 'deleted',
      mediaUrl: null
    });

    const sequence = repository.listViewerSequence(viewerFilters(), null, null, 24, tokenContext);
    expect(sequence.total).toBe(2);
    expect(sequence.items.map((item) => item.jobId)).not.toContain('viewer-job-001');
    expect(sequence.items.map((item) => item.outputId)).toEqual(
      grid.items.flatMap((item) =>
        item.representative?.outputId &&
        item.representative.downloadState === 'verified' &&
        item.representative.mediaUrl
          ? [item.representative.outputId]
          : []
      )
    );
  });

  test('keeps listLibrary semantics separate and rejects tampered, mismatched, and stale continuations', async () => {
    const fixture = await viewerSequenceFixture(3);
    const repository = new LibraryRepository(fixture.database);
    const filters = viewerFilters();
    const listBefore = repository.listLibrary(library, 24);
    const first = repository.listViewerSequence(filters, null, null, 2, tokenContext);
    expect(listBefore).toEqual(repository.listLibrary(library, 24));
    expect(() =>
      repository.listViewerSequence(
        filters,
        first.nextCursor,
        `${first.snapshot}x`,
        2,
        tokenContext
      )
    ).toThrow('Viewer sequence changed');
    expect(() =>
      repository.listViewerSequence(
        { ...filters, mediaKind: 'video' },
        first.nextCursor,
        first.snapshot,
        2,
        tokenContext
      )
    ).toThrow('Viewer sequence changed');
    expect(() =>
      repository.listViewerSequence(filters, first.nextCursor, first.snapshot, 3, tokenContext)
    ).toThrow('Viewer sequence changed');
    expect(() =>
      repository.listViewerSequence(filters, first.nextCursor, first.snapshot, 2, {
        ...tokenContext,
        nonce: 'after-restart'
      })
    ).toThrow('Viewer sequence changed');

    fixture.database
      .query("UPDATE jobs SET prompt_text='mutation' WHERE id=?")
      .run('viewer-job-000');
    expect(() =>
      repository.listViewerSequence(filters, first.nextCursor, first.snapshot, 2, tokenContext)
    ).toThrow('Viewer sequence changed');
  });

  test('returns empty and one-page sequences with one count, filters media, and uses verified representatives', async () => {
    const empty = await viewerSequenceFixture(0);
    const emptyObservations: ViewerSequenceQueryObservation[] = [];
    const emptyPage = new LibraryRepository(empty.database).listViewerSequence(
      viewerFilters(),
      null,
      null,
      100,
      tokenContext,
      (item) => emptyObservations.push(item)
    );
    expect(emptyPage).toMatchObject({ items: [], nextCursor: null, total: 0 });
    expect(emptyObservations.filter((item) => item.operation === 'count')).toHaveLength(1);

    const fixture = await viewerSequenceFixture(3);
    const observations: ViewerSequenceQueryObservation[] = [];
    const page = new LibraryRepository(fixture.database).listViewerSequence(
      { ...viewerFilters(), mediaKind: 'video' },
      null,
      null,
      100,
      tokenContext,
      (item) => observations.push(item)
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      jobId: 'viewer-job-001',
      outputId: 'viewer-output-1',
      mediaKind: 'video',
      mediaUrl: '/api/media/viewer-output-1'
    });
    expect(page).toMatchObject({ nextCursor: null, total: 1 });
    expect(observations.filter((item) => item.operation === 'count')).toHaveLength(1);
  });
});
