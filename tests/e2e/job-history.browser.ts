import { Database } from 'bun:sqlite';
import { expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Locator } from 'playwright';
import { JobRepository } from '../../src/lib/server/jobs/repository';
import { TEST_MEDIA_ORIGIN } from '../../src/lib/server/jobs/runtime-settings';
import { LibraryRepository } from '../../src/lib/server/library/repository';
import { startBrowserAppHarness } from '../helpers/browser-app-harness';
import { pageHasNoHorizontalOverflow } from '../helpers/browser-assertions';

setDefaultTimeout(60_000);

test('job detail reveals lifecycle history in bounded pages', async () => {
  const harness = await startBrowserAppHarness();
  await harness.stopApp();
  const database = new Database(harness.databasePath, { strict: true });
  const repository = new JobRepository(database, () => new Date('2026-07-18T20:00:00.000Z'));
  const job = repository.create({
    actionId: crypto.randomUUID(),
    workflow: 'text-to-image',
    publicModelId: 'flux-schnell',
    guidedRequest: { prompt: 'Bounded lifecycle history' },
    normalizedPayload: {
      model: 'flux-schnell',
      input: { prompt: 'Bounded lifecycle history' }
    }
  });
  const insertEvent = database.query(
    `INSERT INTO job_events(
      job_id,event_type,local_phase,remote_status_raw,remote_status,failure_domain,
      progress,safe_payload_json,observed_at
    ) VALUES (?,?,?,?,?,?,?,?,?)`
  );
  for (let index = 1; index < 45; index += 1) {
    insertEvent.run(
      job.id,
      'status.observed',
      'monitoring',
      'running',
      'running',
      'none',
      index,
      JSON.stringify({ observedProgress: index }),
      new Date(Date.parse('2026-07-18T20:00:00.000Z') + index * 1000).toISOString()
    );
  }
  database
    .query(
      `UPDATE jobs
       SET local_phase='complete',remote_status_raw='finished',remote_status='finished',
           completed_at='2026-07-18T20:01:00.000Z',updated_at='2026-07-18T20:01:00.000Z'
       WHERE id=?`
    )
    .run(job.id);
  database.close();
  await harness.startApp();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    await page.goto(`${harness.url}/jobs/${job.id}`);
    const history = page.locator('section[aria-labelledby="history-heading"]');
    const entries = history.locator('ol > li');

    await page.getByText('Showing 20 of 45', { exact: true }).waitFor();
    expect(await entries.count()).toBe(20);
    await page.getByRole('button', { name: 'Show 20 older events' }).click();
    await page.getByText('Showing 40 of 45', { exact: true }).waitFor();
    expect(await entries.count()).toBe(40);
    await page.getByRole('button', { name: 'Show 20 older events' }).click();
    await page.getByText('Showing 45 of 45', { exact: true }).waitFor();
    expect(await entries.count()).toBe(45);
    expect(await page.getByRole('button', { name: 'Show 20 older events' }).count()).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${harness.url}/jobs`);
    await page.getByRole('heading', { name: 'Activity ledger', level: 2 }).waitFor();
    expect(await pageHasNoHorizontalOverflow(page)).toBe(true);
  } finally {
    await context.close();
    await browser.close();
    await harness.cleanup();
  }
});

test('image chronology navigation updates from durable output events without redirecting', async () => {
  const harness = await startBrowserAppHarness();
  await harness.stopApp();
  const database = new Database(harness.databasePath, { strict: true });
  let now = new Date('2026-07-18T20:00:02.000Z');
  const repository = new JobRepository(database, () => now);

  async function createImage(suffix: string, createdAt: string, availability: 'failed' | 'ready') {
    now = new Date(createdAt);
    const job = repository.create({
      actionId: crypto.randomUUID(),
      entryKey: 'flux-schnell:text-to-image',
      workflow: 'text-to-image',
      publicModelId: 'flux-schnell',
      guidedRequest: { prompt: suffix },
      normalizedPayload: { model: 'flux-schnell', input: { prompt: suffix } },
      prompt: suffix,
      correlationId: `correlation-${suffix}`
    });
    repository.applyStatus(
      job.id,
      {
        taskId: `task-${suffix}`,
        statusRaw: 'finished',
        status: 'finished',
        creditsAmount: 1,
        files: [
          {
            url: `${TEST_MEDIA_ORIGIN}/media/${suffix}.png`,
            fileType: 'image',
            label: null,
            format: 'png',
            contentType: 'image/png',
            fileName: `${suffix}.png`,
            fileSize: 68
          }
        ],
        createdTime: createdAt,
        progress: 100,
        errorMessage: null
      },
      1000
    );
    const output = repository.outputs(job.id)[0];
    if (!output) throw new Error('Expected a fixture output.');
    if (availability === 'failed') {
      database.query("UPDATE job_outputs SET download_state='failed' WHERE id=?").run(output.id);
      database
        .query(
          "UPDATE jobs SET local_phase='requires_attention',failure_domain='download',attention_code='download_failed' WHERE id=?"
        )
        .run(job.id);
      return { job, output };
    }

    const directory = join(harness.appData, 'media', job.id);
    const localPath = join(directory, `${suffix}.png`);
    await mkdir(directory, { recursive: true });
    await writeFile(localPath, await Bun.file('tests/fixtures/media/tiny.png').bytes());
    const attempt = repository.startDownload(output.id);
    repository.verifyDownload(output.id, attempt, {
      path: localPath,
      size: 68,
      checksum: `checksum-${suffix}`,
      signature: '89504e47',
      contentType: 'image/png',
      pixelWidth: 1,
      pixelHeight: 1,
      aspectRatio: '1:1'
    });
    repository.finishIfDownloaded(job.id);
    return { job, output };
  }

  const second = await createImage('second-ready', '2026-07-18T20:00:02.000Z', 'ready');
  const third = await createImage('third-late', '2026-07-18T20:00:03.000Z', 'failed');
  const fifth = await createImage('fifth-ready', '2026-07-18T20:00:05.000Z', 'ready');
  database.close();
  await harness.startApp();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  async function waitForNextHref(next: Locator, href: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if ((await next.getAttribute('href')) === href) return;
      await Bun.sleep(50);
    }
    throw new Error(`Next image did not update to ${href}.`);
  }

  try {
    const eventStream = page.waitForRequest(
      (request) => new URL(request.url()).pathname === '/api/events/jobs'
    );
    await page.goto(`${harness.url}/jobs/${second.job.id}`);
    await eventStream;

    const previous = page.getByRole('button', { name: 'Previous image unavailable' });
    expect(await previous.isDisabled()).toBe(true);
    const next = page.getByRole('link', { name: /^Next image:/ });
    expect(await next.getAttribute('href')).toBe(`/jobs/${fifth.job.id}`);
    await mkdir('test-results', { recursive: true });
    await page.screenshot({
      path: 'test-results/job-image-navigation-desktop.png',
      fullPage: true
    });

    await next.focus();
    expect(await next.evaluate((element) => element === document.activeElement)).toBe(true);

    const retryStatus = await page.evaluate(
      async ({ jobId, outputId }) => {
        const response = await fetch(`/api/jobs/${jobId}/outputs/${outputId}/retry`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}'
        });
        return response.status;
      },
      { jobId: third.job.id, outputId: third.output.id }
    );
    expect(retryStatus).toBe(202);
    await waitForNextHref(next, `/jobs/${third.job.id}`);
    expect(page.url()).toBe(`${harness.url}/jobs/${second.job.id}`);

    const liveDatabase = new Database(harness.databasePath, { strict: true });
    try {
      await new LibraryRepository(liveDatabase).deleteOutput(
        third.job.id,
        third.output.id,
        'file',
        { media: await realpath(join(harness.appData, 'media')) }
      );
    } finally {
      liveDatabase.close();
    }
    await waitForNextHref(next, `/jobs/${fifth.job.id}`);

    await page.setViewportSize({ width: 390, height: 844 });
    const navigationBox = await page
      .getByRole('navigation', { name: 'Image job chronology' })
      .boundingBox();
    expect(navigationBox).not.toBeNull();
    expect((navigationBox?.x ?? 0) + (navigationBox?.width ?? 0)).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: 'test-results/job-image-navigation-mobile.png',
      fullPage: true
    });

    await next.click();
    await page.waitForURL(`${harness.url}/jobs/${fifth.job.id}`);
    expect(await page.locator('body').innerText()).toContain(fifth.job.id);
    expect(await page.locator('body').innerText()).not.toContain(harness.appData);
    expect(await page.getByRole('button', { name: 'Next image unavailable' }).isDisabled()).toBe(
      true
    );
  } finally {
    await context.close();
    await browser.close();
    await harness.cleanup();
  }
});

test('Activity retries a failed job without automatic retries and keeps failures recoverable', async () => {
  const harness = await startBrowserAppHarness();
  await harness.stopApp();
  const database = new Database(harness.databasePath, { strict: true });
  const repository = new JobRepository(database);
  const job = repository.create({
    actionId: crypto.randomUUID(),
    entryKey: 'flux-schnell:text-to-image',
    workflow: 'text-to-image',
    publicModelId: 'flux-schnell',
    guidedRequest: { prompt: 'Manual retry without automatic retries' },
    normalizedPayload: {
      model: 'flux-schnell',
      input: { prompt: 'Manual retry without automatic retries' }
    }
  });
  database
    .query(
      "UPDATE jobs SET local_phase='complete',remote_status='failed',remote_status_raw='failed' WHERE id=?"
    )
    .run(job.id);
  database.close();
  await harness.startApp();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const actionIds: string[] = [];
  let rejectRequest = true;
  try {
    await page.route(`**/api/jobs/${job.id}/rerun`, async (route) => {
      const body = route.request().postDataJSON();
      expect(body.acknowledgeNewPaidJob).toBe(true);
      actionIds.push(body.actionId);
      if (rejectRequest) {
        await route.fulfill({ status: 409, json: { error: 'Retry temporarily unavailable.' } });
      } else {
        await route.continue();
      }
    });
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(`${harness.url}/jobs`);
    const retry = page.getByRole('button', { name: /^Retry failed job:/ });
    await retry.waitFor();
    expect(await page.getByText(/Attempt \d+ of/).count()).toBe(0);
    expect(await pageHasNoHorizontalOverflow(page)).toBe(true);
    await retry.click();
    await page.getByRole('alert').filter({ hasText: 'Could not retry this job.' }).waitFor();
    expect(await retry.isEnabled()).toBe(true);
    rejectRequest = false;
    await retry.click();
    await page.waitForURL(
      (url) => url.pathname.startsWith('/jobs/') && url.pathname !== `/jobs/${job.id}`
    );
    expect(actionIds.length).toBe(2);
    expect(actionIds[0]).toBe(actionIds[1]);
  } finally {
    await browser.close();
    await harness.cleanup();
  }
});
