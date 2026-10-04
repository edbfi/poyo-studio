import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { variables } from '../../../src/env';

// SvelteKit 3 exposes only the variables declared in src/env.ts through `$app/env/private`; an
// undeclared name silently reads as undefined. These names are read straight from the process
// environment instead, outside SvelteKit, so they are deliberately not declared.
const DIRECT_PROCESS_READS = ['PLS_CLEANUP_INTERVAL_MS'];

interface SourceFile {
  path: string;
  text: string;
}

async function serverSources(): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  for await (const path of new Glob('src/**/*.{ts,svelte}').scan('.')) {
    if (path === 'src/env.ts') continue;
    files.push({ path, text: await Bun.file(path).text() });
  }
  return files;
}

/**
 * Upper-case property reads on the environment objects: `env.X` (the `$app/env/private` namespace)
 * and `environment.X` (that namespace passed on as `platform.environment`), versus direct
 * `Bun.env.X` and `process.env.X` reads.
 */
async function environmentReads() {
  const kit = new Set<string>();
  const direct = new Set<string>();
  for (const { text } of await serverSources()) {
    for (const match of text.matchAll(
      /\b(Bun\.env|process\.env|environment|env)\??\.([A-Z][A-Z0-9_]*)\b/g
    )) {
      const [, object, name] = match as unknown as [string, string, string];
      (object === 'Bun.env' || object === 'process.env' ? direct : kit).add(name);
    }
  }
  return { kit: [...kit].sort(), direct: [...direct].sort() };
}

describe('SvelteKit 3 environment declarations', () => {
  test('declares exactly the variables the server code reads through SvelteKit', async () => {
    const { kit, direct } = await environmentReads();
    expect(Object.keys(variables).sort()).toEqual(kit);
    expect(direct).toEqual([...DIRECT_PROCESS_READS].sort());
    for (const name of DIRECT_PROCESS_READS) expect(kit).not.toContain(name);
  });

  test('reads private variables only through the $app/env/private namespace', async () => {
    for (const { path, text } of await serverSources()) {
      expect(text, path).not.toMatch(/from\s+['"]\$env\//);
      for (const match of text.matchAll(
        /import\s+([^;]*?)\s+from\s+['"]\$app\/env\/private['"]/g
      )) {
        expect(match[1], path).toBe('* as env');
      }
    }
  });

  test('keeps every variable private, dynamic and optional with its raw value', () => {
    for (const [name, config] of Object.entries(variables)) {
      const options = config as { public?: boolean; static?: boolean };
      expect(options.public, name).toBeFalsy();
      expect(options.static, name).toBeFalsy();
      const schema = config.schema['~standard'];
      expect(schema.validate(undefined), name).toEqual({ value: undefined });
      expect(schema.validate(''), name).toEqual({ value: '' });
      expect(schema.validate('1'), name).toEqual({ value: '1' });
    }
  });
});
