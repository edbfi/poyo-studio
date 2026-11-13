import { afterEach, describe, expect, test } from 'bun:test';
import { JobCoordinator } from '../../../src/lib/server/jobs/coordinator';
import { OutputDownloader } from '../../../src/lib/server/jobs/downloader';
import { decodeEventChunk, initialJobEvents } from '../../../src/lib/server/jobs/events';
import { JobRepository } from '../../../src/lib/server/jobs/repository';
import { LibraryRepository } from '../../../src/lib/server/library/repository';
import { PoyoClient } from '../../../src/lib/server/poyo/client';
import { MemoryPoyoMetadataLogger } from '../../../src/lib/server/poyo/logging';
import { parseStatusResponse, parseSubmitResponse } from '../../../src/lib/server/poyo/parsers';
import { PoyoTransport } from '../../../src/lib/server/poyo/transport';
import evidence from '../../fixtures/poyo/rejection-diagnostics.json';
import { createJobFixture } from '../../helpers/job-fixture';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

// All network responses below are injected synthetic mutations or documented examples.
// No real Poyo API request is made and none of these are incident captures.
describe('durable provider diagnostic paths', () => {
  test('settles an under-detailed terminal ack once from a later poll without repeated events', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = fixture.repository.create({
      actionId: crypto.randomUUID(),
      workflow: 'text-to-image',
      publicModelId: 'provider/model',
      guidedRequest: {},
      normalizedPayload: { model: 'provider/model', input: {} }
    });
    const claim = fixture.repository.claimSubmission(job.id, 'test', 1000);
    if (!claim) throw new Error('Expected submission claim');
    fixture.repository.acknowledgeSubmission(
      job.id,
      claim.token,
      parseSubmitResponse(
        {
          code: 200,
          data: { task_id: 'task-diagnostic', status: 'failed', created_time: 'now' }
        },
        200
      )
    );
    const status = parseStatusResponse(
      {
        ...evidence.documentedFailedStatus,
        data: { ...evidence.documentedFailedStatus.data, task_id: 'task-diagnostic' }
      },
      200
    );
    fixture.repository.applyStatus(job.id, status, 1000);
    const before = fixture.repository.get(job.id);
    fixture.repository.applyStatus(job.id, status, 1000);
    expect(fixture.repository.get(job.id)).toEqual(before);
    expect(before?.remoteStatus).toBe('failed');
    const diagnostics = fixture.repository
      .eventsAfter(0)
      .filter((e) => e.eventType === 'status.observed');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.payload?.providerDiagnostic).toMatchObject({
      source: 'status',
      documentedMessage: evidence.documentedFailedStatus.data.error_message
    });
  });
  for (const workflow of ['text-to-image', 'image-to-image']) {
    for (const seedExplicit of [false, true]) {
      for (const path of ['submit_error', 'submit_ack', 'status', 'poll_error'] as const) {
        test(`${workflow} ${path}: seed ${seedExplicit ? 'explicit' : 'omitted'}, private durable metadata`, async () => {
          const fixture = await createJobFixture();
          cleanups.push(fixture.cleanup);
          const prompt = 'SingleTokenPromptCanary';
          const url = 'https://private.example/secret-path?private_signature=url-canary';
          const input = {
            prompt,
            ...(seedExplicit ? { seed: 987654321 } : {}),
            quantity: 2,
            enable_safety_checker: false,
            moderation: 'original-value',
            ...(workflow === 'image-to-image' ? { image_urls: [url] } : {})
          };
          const job = fixture.repository.create({
            actionId: crypto.randomUUID(),
            workflow,
            publicModelId: 'provider/model',
            guidedRequest: { prompt },
            normalizedPayload: { model: 'provider/model', input }
          });
          const cursor = fixture.repository.eventBounds().max;
          let submitCalls = 0;
          const logger = new MemoryPoyoMetadataLogger();
          const echoedError = {
            code: 422,
            error: {
              type: 'PrivateCredentialAbCd1234_5678',
              code: 'PrivateCredentialAbCd1234_5678',
              message: `${prompt} ${url} Bearer token-canary sk-private_canary_12345`,
              details: { input }
            },
            data: { status: 'cancelled', input }
          };
          const poyo = new PoyoClient(
            new PoyoTransport({
              apiKey: 'sk-test_key_not_sent_123456',
              logger,
              fetch: async (request, options) => {
                const pathname = new URL(String(request)).pathname;
                if (pathname === '/api/user/balance')
                  return Response.json({
                    data: { email: 'test@example.test', credits_amount: 100 }
                  });
                if (pathname === '/api/generate/submit') {
                  submitCalls += 1;
                  expect(JSON.parse(String(options?.body))).toEqual({
                    model: 'provider/model',
                    input
                  });
                  if (path === 'submit_error') return Response.json(echoedError);
                  return Response.json({
                    code: 200,
                    data: {
                      task_id: 'task-diagnostic',
                      created_time: '2026-11-13T12:00:00Z',
                      status: path === 'submit_ack' ? 'canceled' : 'running',
                      error_message: path === 'submit_ack' ? `${prompt} ${url}` : null,
                      error_code: path === 'submit_ack' ? 'E_ACK' : undefined
                    }
                  });
                }
                if (path === 'poll_error') return Response.json(echoedError, { status: 422 });
                return Response.json({
                  ...evidence.documentedFailedStatus,
                  data: {
                    ...evidence.documentedFailedStatus.data,
                    task_id: 'task-diagnostic',
                    status: 'cancelled',
                    error_code: 'E_TASK',
                    error_message: `${prompt} ${url}`
                  }
                });
              }
            }),
            { now: () => Date.parse('2026-11-13T12:00:00Z') }
          );
          const coordinator = new JobCoordinator({
            repository: fixture.repository,
            poyo,
            downloader: new OutputDownloader({
              repository: fixture.repository,
              paths: fixture.paths
            }),
            automaticDownloads: false
          });
          await coordinator.submit(job.id);
          if (path === 'status' || path === 'poll_error') await coordinator.poll(job.id);
          await coordinator.recoverOnce();
          expect(submitCalls).toBe(1);
          expect(fixture.repository.get(job.id)?.normalizedPayload.input).toEqual(input);
          expect(fixture.repository.snapshot().jobs).toHaveLength(1);

          const eventType = {
            submit_error: 'submission.rejected',
            submit_ack: 'submission.acknowledged',
            status: 'status.observed',
            poll_error: 'poll.failed'
          }[path];
          // A fresh repository instance reads persisted events, without process-local metadata.
          const restarted = new JobRepository(fixture.database);
          const event = restarted.eventsAfter(cursor).find((item) => item.eventType === eventType);
          expect(event?.payload?.providerDiagnostic).toMatchObject({
            version: 1,
            source: path,
            seed_explicit: seedExplicit,
            statusRaw: path === 'submit_ack' ? 'canceled' : 'cancelled',
            errorMessagePresent: true,
            documentedMessage: null,
            ...(path === 'submit_ack' || path === 'status' ? { httpStatus: 200 } : {}),
            ...(path === 'submit_error' ? { httpStatus: 200, responseCode: 422 } : {}),
            ...(path === 'poll_error' ? { httpStatus: 422, responseCode: 422 } : {})
          });
          const detail = await new LibraryRepository(fixture.database).getJobDetail(job.id);
          expect(event?.payload?.providerDiagnostic).toEqual(
            detail?.history.find((item) => item.eventType === eventType)?.providerDiagnostic
          );
          const replay = initialJobEvents(restarted, String(cursor)).chunks.map(decodeEventChunk);
          const outward = JSON.stringify({ history: detail?.history, replay, logs: logger.events });
          for (const canary of [
            prompt,
            url,
            'token-canary',
            'sk-private',
            '987654321',
            'PrivateCredentialAbCd1234_5678'
          ])
            expect(outward).not.toContain(canary);
          expect(
            replay.some((item) => JSON.stringify(item.data).includes('providerDiagnostic'))
          ).toBe(true);
        });
      }
    }
  }

  test('legacy and tampered history exposes only the bounded diagnostic projection', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = fixture.repository.create({
      actionId: crypto.randomUUID(),
      workflow: 'text-to-image',
      publicModelId: 'provider/model',
      guidedRequest: {},
      normalizedPayload: { model: 'provider/model', input: {} }
    });
    fixture.repository.transition(job.id, 'submitting', 'none', null, 'synthetic.tampered', {
      providerDiagnostic: {
        version: 1,
        source: 'status',
        seed_explicit: false,
        statusRaw: 'cancelled',
        errorType: 'https://private.example/private-canary',
        documentedMessage: 'private-canary',
        errorMessagePresent: true,
        arbitrary: 'private-canary'
      }
    });
    const detail = await new LibraryRepository(fixture.database).getJobDetail(job.id);
    expect(detail?.history[0]?.providerDiagnostic).toMatchObject({
      statusRaw: 'cancelled',
      errorType: null,
      documentedMessage: null
    });
    const replay = initialJobEvents(fixture.repository, '0').chunks.map(decodeEventChunk);
    expect(JSON.stringify({ history: detail?.history, replay })).not.toContain('private-canary');
  });
});
