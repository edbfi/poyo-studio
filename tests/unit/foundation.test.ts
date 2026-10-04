import { describe, expect, test } from 'bun:test';

interface PackageManifest {
  packageManager: string;
  engines: { bun: string };
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
}

const pinnedPackages = [
  '@biomejs/biome',
  '@sveltejs/adapter-bun',
  '@sveltejs/kit',
  '@sveltejs/vite-plugin-svelte',
  '@unocss/extractor-svelte',
  '@unocss/preset-wind4',
  '@unocss/vite',
  'svelte',
  'svelte-check',
  'typescript',
  'unocss',
  'vite'
];

describe('Bun SvelteKit foundation', () => {
  test('pins the verified runtime and dependency baseline', async () => {
    const manifest = (await Bun.file('package.json').json()) as PackageManifest;

    const runtime = (await Bun.file('.bun-version').text()).trim();
    expect(runtime).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Bun.version).toBe(runtime);
    expect(manifest.packageManager).toBe(`bun@${runtime}`);
    expect(manifest.engines.bun).toBe(runtime);
    expect(manifest.scripts.dev).toBe('bun --bun vite dev --host 127.0.0.1');
    for (const name of pinnedPackages) {
      expect(manifest.devDependencies[name]).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  test('uses the Bun adapter and UnoCSS before SvelteKit', async () => {
    const viteConfig = await Bun.file('vite.config.ts').text();
    const clientHook = await Bun.file('src/hooks.client.ts').text();

    expect(viteConfig).toContain("from '@sveltejs/adapter-bun'");
    expect(viteConfig).not.toContain('adapter-node');
    expect(await Bun.file('svelte.config.ts').exists()).toBe(false);
    expect(viteConfig.indexOf('UnoCSS()')).toBeGreaterThan(-1);
    expect(viteConfig.indexOf('UnoCSS()')).toBeLessThan(viteConfig.indexOf('sveltekit('));
    expect(clientHook).toContain("import 'uno.css'");
  });

  test('does not activate Tailwind or Node package managers', async () => {
    const manifest = await Bun.file('package.json').text();

    expect(manifest).not.toContain('tailwind');
    expect(await Bun.file('package-lock.json').exists()).toBe(false);
    expect(await Bun.file('pnpm-lock.yaml').exists()).toBe(false);
    expect(await Bun.file('yarn.lock').exists()).toBe(false);
  });
});
