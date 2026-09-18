import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { chromium, type Page } from 'playwright';
import { trackBrowserIssues } from '../helpers/browser-assertions';
import { startGalleryViewerComponentHarness } from '../helpers/gallery-viewer-component-harness';

setDefaultTimeout(60_000);

let harness: Awaited<ReturnType<typeof startGalleryViewerComponentHarness>>;

beforeAll(async () => {
  harness = await startGalleryViewerComponentHarness();
});

afterAll(async () => {
  await harness.stop();
});

type LifecycleControl =
  | 'Next item'
  | 'Close'
  | 'Escape'
  | 'Outside close'
  | 'Set parent open false'
  | 'Remove selected group'
  | 'Unmount viewer';

interface LifecycleTiming {
  pauseAt: number | null;
  pauseConnected: boolean | null;
  pauseCalls: number;
  wasPlayingAtPause: boolean | null;
  pausedAfterPause: boolean | null;
  disconnectAt: number | null;
}
async function closeResources(
  cleanup: Array<() => Promise<void>>,
  primaryError?: unknown,
  preservePrimaryError = false
): Promise<void> {
  const cleanupErrors: unknown[] = [];
  for (const close of cleanup) {
    try {
      await close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (cleanupErrors.length === 0) return;
  if (preservePrimaryError) {
    throw new AggregateError(
      cleanupErrors,
      'GalleryViewer lifecycle operation and cleanup failed.',
      {
        cause: primaryError
      }
    );
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  throw new AggregateError(cleanupErrors, 'GalleryViewer lifecycle cleanup failed.');
}

async function assertModalExternalControlsAreInert(page: Page): Promise<void> {
  const externalControls = await page
    .locator('[data-testid="gallery-viewer-parent-controls"] button')
    .evaluateAll((buttons) => {
      const dialogElement = document.querySelector('[role="dialog"]');
      return buttons.map((button) => {
        const outsideDialog = !dialogElement?.contains(button);
        const pointerEvents = getComputedStyle(button).pointerEvents;
        return {
          outsideDialog,
          modalExternalInert:
            outsideDialog &&
            dialogElement?.getAttribute('aria-modal') === 'true' &&
            pointerEvents === 'none',
          pointerEvents
        };
      });
    });

  expect(externalControls).toHaveLength(9);
  for (const control of externalControls) {
    expect(control.outsideDialog).toBe(true);
    expect(control.modalExternalInert).toBe(true);
    expect(control.pointerEvents).toBe('none');
  }
}

async function openPlayingVideo(page: Page) {
  await page
    .getByRole('button', { name: 'Open video', exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());

  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  const video = dialog.locator('video');
  await video.waitFor();
  await assertModalExternalControlsAreInert(page);

  const playback = await video.evaluate(async (element: HTMLVideoElement) => {
    type TimingWindow = Window & { __galleryViewerLifecycleTiming?: LifecycleTiming };
    const lifecycleWindow = window as TimingWindow;
    const timing: LifecycleTiming = {
      pauseAt: null,
      pauseConnected: null,
      pauseCalls: 0,
      wasPlayingAtPause: null,
      pausedAfterPause: null,
      disconnectAt: null
    };
    lifecycleWindow.__galleryViewerLifecycleTiming = timing;

    const observer = new MutationObserver(() => {
      if (!element.isConnected && timing.disconnectAt === null) {
        timing.disconnectAt = performance.now();
        observer.disconnect();
      }
    });
    observer.observe(document, { childList: true, subtree: true });

    const originalPause = element.pause;
    Object.defineProperty(element, 'pause', {
      configurable: true,
      value: function pause(): void {
        timing.pauseCalls += 1;
        if (timing.pauseAt === null) {
          timing.pauseAt = performance.now();
          timing.pauseConnected = element.isConnected;
          timing.wasPlayingAtPause = !element.paused;
        }
        originalPause.call(element);
        if (timing.pauseCalls === 1) timing.pausedAfterPause = element.paused;
      }
    });

    await new Promise<void>((resolve, reject) => {
      if (element.readyState >= HTMLMediaElement.HAVE_METADATA) {
        resolve();
        return;
      }
      element.addEventListener('loadedmetadata', () => resolve(), { once: true });
      element.addEventListener('error', () => reject(new Error('Video metadata failed to load.')), {
        once: true
      });
    });

    if (element.duration < 3)
      throw new Error(`Lifecycle video fixture is ${element.duration}s; expected at least 3s.`);
    element.muted = true;
    element.currentTime = 1;
    await element.play();
    return { currentTime: element.currentTime, duration: element.duration, paused: element.paused };
  });

  expect(playback.duration).toBeGreaterThanOrEqual(3);
  expect(playback.currentTime).toBeGreaterThanOrEqual(0.9);
  expect(playback.currentTime).toBeLessThan(playback.duration - 0.5);
  expect(playback.paused).toBe(false);
  return video;
}

async function activateLifecycleControl(page: Page, control: LifecycleControl): Promise<void> {
  switch (control) {
    case 'Next item':
    case 'Close':
      await page.getByRole('button', { name: control, exact: true }).click();
      return;
    case 'Escape':
      await page.keyboard.press('Escape');
      return;
    case 'Outside close': {
      const dialog = page.getByRole('dialog');
      const bounds = await dialog.boundingBox();
      if (!bounds)
        throw new Error('GalleryViewer dialog did not have layout for outside-close coverage.');
      const x = bounds.x > 8 ? bounds.x - 4 : bounds.x + bounds.width + 4;
      await page.mouse.click(x, Math.max(4, bounds.y + 4));
      return;
    }
    case 'Set parent open false':
    case 'Remove selected group':
    case 'Unmount viewer':
      await page
        .locator('[data-testid="gallery-viewer-parent-controls"] button')
        .filter({ hasText: control })
        .evaluate((button: HTMLButtonElement) => button.click());
      return;
  }
}

async function verifyLifecycleScenario(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  url: string,
  control: LifecycleControl
): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const issues = trackBrowserIssues(page);
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    await page.goto(url);
    const video = await openPlayingVideo(page);

    await activateLifecycleControl(page, control);

    await video.waitFor({ state: 'detached' });
    if (control === 'Next item') {
      await page.getByRole('dialog').waitFor();
      await page.getByRole('img', { name: 'Lifecycle follow-up fixture', exact: true }).waitFor();
    } else {
      await page.getByRole('dialog').waitFor({ state: 'detached' });
    }
    await page.waitForFunction(() => {
      const disconnectAt = (window as Window & { __galleryViewerLifecycleTiming?: LifecycleTiming })
        .__galleryViewerLifecycleTiming?.disconnectAt;
      return typeof disconnectAt === 'number';
    });

    const timing = await page.evaluate(
      () =>
        (window as Window & { __galleryViewerLifecycleTiming?: LifecycleTiming })
          .__galleryViewerLifecycleTiming
    );
    expect(timing).toBeDefined();
    expect(timing?.pauseCalls).toBe(1);
    expect(timing?.wasPlayingAtPause).toBe(true);
    expect(timing?.pausedAfterPause).toBe(true);
    if (timing?.pauseConnected !== true) {
      throw new Error(`${control} paused the video after it disconnected.`);
    }
    const pauseAt = timing?.pauseAt;
    const disconnectAt = timing?.disconnectAt;
    if (typeof pauseAt !== 'number' || typeof disconnectAt !== 'number') {
      throw new Error('GalleryViewer lifecycle timing was not recorded.');
    }
    expect(pauseAt).toBeLessThanOrEqual(disconnectAt);
    expect(issues.consoleErrors).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
    throw error;
  } finally {
    await closeResources([() => page.close()], primaryError, hasPrimaryError);
  }
}

test('GalleryViewer retains selected media nodes and state when newer full-history items prepend', async () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let page: Page | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  const parentControl = async (name: string): Promise<void> => {
    if (!page) throw new Error('GalleryViewer history page was not created.');
    await page
      .locator('[data-testid="gallery-viewer-parent-controls"] button')
      .filter({ hasText: name })
      .evaluate((button: HTMLButtonElement) => button.click());
  };
  try {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const issues = trackBrowserIssues(page);
    await page.goto(harness.url);

    await parentControl('Open history image');
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    const image = dialog.getByRole('img', { name: 'Lifecycle history image fixture', exact: true });
    await image.waitFor();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="gallery-viewer-viewport"]')
          ?.getAttribute('aria-busy') === 'false'
    );
    await dialog.getByRole('button', { name: 'Actual size', exact: true }).click();
    await page.waitForFunction(() => {
      const viewport = document.querySelector('[data-testid="gallery-viewer-viewport"]');
      const selected = viewport?.querySelector('img');
      if (!(selected instanceof HTMLImageElement)) return false;
      const rect = selected.getBoundingClientRect();
      return (
        viewport?.getAttribute('data-zoom-mode') === 'actual' &&
        Math.abs(rect.width - selected.naturalWidth) < 1 &&
        Math.abs(rect.height - selected.naturalHeight) < 1
      );
    });
    const initial = await image.evaluate((element) => {
      if (!(element instanceof HTMLImageElement))
        throw new Error('Expected history image element.');
      (window as Window & { __galleryHistoryImage?: HTMLImageElement }).__galleryHistoryImage =
        element;
      return {
        width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height,
        previousDisabled: document.querySelector<HTMLButtonElement>('[aria-label="Previous item"]')
          ?.disabled
      };
    });
    expect(initial.previousDisabled).toBe(true);

    await parentControl('Prepend newer history item');
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="gallery-viewer-item-status"]')
          ?.textContent?.includes('item 2 of 2') === true
    );
    expect(
      await dialog.getByRole('button', { name: 'Previous item', exact: true }).isDisabled()
    ).toBe(false);
    const retained = await image.evaluate((element) => ({
      sameNode:
        (window as Window & { __galleryHistoryImage?: HTMLImageElement }).__galleryHistoryImage ===
        element,
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height
    }));
    expect(retained.sameNode).toBe(true);
    // The item counter can resize the viewport. Actual-size mode reconciles its
    // fitted dimensions and scale together, preserving the rendered image size.
    expect(retained.width).toBeCloseTo(initial.width, 0);
    expect(retained.height).toBeCloseTo(initial.height, 0);
    expect(await page.getByTestId('gallery-viewer-viewport').getAttribute('data-zoom-mode')).toBe(
      'actual'
    );

    await parentControl('Fail history update');
    await dialog.getByRole('alert').waitFor({ timeout: 5_000 });
    await dialog.getByRole('button', { name: 'Retry', exact: true }).click({ timeout: 5_000 });
    await dialog.getByRole('alert').waitFor({ state: 'detached', timeout: 5_000 });
    expect(issues.consoleErrors).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
    throw error;
  } finally {
    await closeResources(
      [
        async () => {
          await page?.close();
        },
        async () => {
          await browser?.close();
        }
      ],
      primaryError,
      hasPrimaryError
    );
  }
});

test('GalleryViewer pauses actively playing media before parent-owned lifecycle disconnects', async () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    browser = await chromium.launch({ headless: true });
    for (const control of [
      'Set parent open false',
      'Remove selected group',
      'Unmount viewer'
    ] satisfies LifecycleControl[]) {
      await verifyLifecycleScenario(browser, harness.url, control);
    }
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
    throw error;
  } finally {
    await closeResources(
      [
        async () => {
          await browser?.close();
        }
      ],
      primaryError,
      hasPrimaryError
    );
  }
});

test('GalleryViewer keeps a playing current video attached when newer history prepends', async () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let page: Page | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const issues = trackBrowserIssues(page);
    await page.goto(harness.url);
    await page
      .locator('[data-testid="gallery-viewer-parent-controls"] button')
      .filter({ hasText: 'Open history video' })
      .evaluate((button: HTMLButtonElement) => button.click());

    const dialog = page.getByRole('dialog');
    const video = dialog.locator('video');
    await video.waitFor();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="gallery-viewer-viewport"]')
          ?.getAttribute('aria-busy') === 'false'
    );
    const playing = await video.evaluate(async (element: HTMLVideoElement) => {
      element.loop = true;
      element.muted = true;
      await element.play();
      (window as Window & { __galleryHistoryVideo?: HTMLVideoElement }).__galleryHistoryVideo =
        element;
      return element.paused;
    });
    expect(playing).toBe(false);

    await page
      .locator('[data-testid="gallery-viewer-parent-controls"] button')
      .filter({ hasText: 'Prepend newer history item' })
      .evaluate((button: HTMLButtonElement) => button.click());
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="gallery-viewer-item-status"]')
          ?.textContent?.includes('item 2 of 2') === true
    );
    const retained = await video.evaluate((element) => {
      if (!(element instanceof HTMLVideoElement))
        throw new Error('Expected history video element.');
      return {
        sameNode:
          (window as Window & { __galleryHistoryVideo?: HTMLVideoElement })
            .__galleryHistoryVideo === element,
        connected: element.isConnected,
        paused: element.paused
      };
    });
    expect(retained).toEqual({ sameNode: true, connected: true, paused: false });
    expect(issues.consoleErrors).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
    throw error;
  } finally {
    await closeResources(
      [
        async () => {
          await page?.close();
        },
        async () => {
          await browser?.close();
        }
      ],
      primaryError,
      hasPrimaryError
    );
  }
});
