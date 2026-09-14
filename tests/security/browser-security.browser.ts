import { expect, setDefaultTimeout, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startBrowserAppHarness } from '../helpers/browser-app-harness';
import { trackBrowserIssues } from '../helpers/browser-assertions';

setDefaultTimeout(90_000);

async function filesWithin(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(path);
    }
  }
  await visit(root);
  return output;
}

test('SEC-02..07 production browser keeps secrets private and mutations same-origin', async () => {
  const harness = await startBrowserAppHarness();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const issues = trackBrowserIssues(page);
  try {
    await page.goto(`${harness.url}/settings/diagnostics`);
    await page.getByRole('heading', { name: 'Application diagnostics' }).waitFor();
    const html = await page.content();
    expect(html).not.toContain(harness.syntheticKey);
    expect(await page.evaluate(() => localStorage.getItem('POYO_API_KEY'))).toBeNull();
    expect(await page.evaluate(() => sessionStorage.getItem('POYO_API_KEY'))).toBeNull();
    expect(JSON.stringify(await context.cookies())).not.toContain(harness.syntheticKey);

    const missingOrigin = await fetch(`${harness.url}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    expect(missingOrigin.status).toBe(403);
    const crossOrigin = await fetch(`${harness.url}/api/settings`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site'
      },
      body: '{}'
    });
    expect(crossOrigin.status).toBe(403);
    expect(
      await page.evaluate(() =>
        fetch('/api/settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: '{}'
        }).then((response) => response.status)
      )
    ).toBe(200);

    const traversal = await fetch(`${harness.url}/api/media/${encodeURIComponent('../secret')}`);
    expect(traversal.status).not.toBe(200);
    const diagnostics = await fetch(`${harness.url}/api/diagnostics`).then((response) =>
      response.text()
    );
    expect(diagnostics).not.toContain(harness.syntheticKey);
    expect(diagnostics).toContain('"apiKey":{"source":"environment"');

    await harness.stopApp();
    const storedFiles = [
      ...(await filesWithin(harness.appData)),
      ...(await filesWithin('build/client'))
    ];
    for (const file of storedFiles) {
      const bytes = await Bun.file(file).bytes();
      expect(new TextDecoder().decode(bytes), file).not.toContain(harness.syntheticKey);
    }
    expect(harness.serverOutput()).not.toContain(harness.syntheticKey);
    expect(issues.consoleErrors).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
  } finally {
    await context.close();
    await browser.close();
    await harness.cleanup();
  }
});
