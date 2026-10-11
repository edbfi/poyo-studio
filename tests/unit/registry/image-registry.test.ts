import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  IMAGE_AUDIT_RECORDS,
  IMAGE_PAGE_SLUGS,
  IMAGE_PUBLIC_IDS,
  IMAGE_REGISTRY,
  IMAGE_REGISTRY_ENTRIES
} from '../../../src/lib/features/registry/image-registry';
import {
  minimumValidRequest,
  normalizeImageRequest,
  RegistryValidationError
} from '../../../src/lib/features/registry/normalize';
import { migrateDatabase } from '../../../src/lib/server/platform/database';
import { seedImageRegistry } from '../../../src/lib/server/registry/repository';

function registryEntry(key: string) {
  const entry = IMAGE_REGISTRY_ENTRIES.find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`Missing registry fixture: ${key}`);
  return entry;
}

describe('audited image registry', () => {
  test('REG-01/02 accounts for all 29 pages, 53 public IDs, and 66 reviewed workflows', () => {
    expect(IMAGE_PAGE_SLUGS).toHaveLength(29);
    expect(new Set(IMAGE_PAGE_SLUGS).size).toBe(29);
    expect(IMAGE_PUBLIC_IDS).toHaveLength(53);
    expect(IMAGE_REGISTRY_ENTRIES).toHaveLength(66);
    expect(new Set(IMAGE_REGISTRY_ENTRIES.map((entry) => entry.key)).size).toBe(66);
    for (const entry of IMAGE_REGISTRY_ENTRIES) {
      expect(entry.provenance.markdownUrl).toStartWith('https://docs.poyo.ai/');
      expect(entry.provenance.markdownSha256).toHaveLength(64);
      expect(entry.provenance.jsonSha256).toHaveLength(64);
      expect(entry.provenance.jsonStatus).toBe('available');
      expect(entry.provenance.sourceManifestVersion).toMatch(/^1:[a-f0-9]{64}$/);
      expect(entry.fields.some((field) => field.level === 'essential')).toBe(true);
      expect(entry.status).toBe('current');
    }
  });
  test('REG-03 every workflow has a functional minimum-valid exact model adapter', () => {
    for (const entry of IMAGE_REGISTRY_ENTRIES) {
      const preview = normalizeImageRequest(entry.key, minimumValidRequest(entry));
      expect(preview.request.model).toBe(entry.publicModelId);
      expect(preview.request.input.prompt).toBe('studio image');
    }
  });
  test('REG-04 validates prompt, reference counts, enums, output counts and custom dimensions', () => {
    const flux = registryEntry('flux-2-pro:text-to-image');
    expect(() =>
      normalizeImageRequest(flux.key, { prompt: 'x', aspectRatio: '1:1', resolution: '1K' })
    ).toThrow('too short');
    const edit = registryEntry('kling-o1-image-edit:image-edit');
    expect(() => normalizeImageRequest(edit.key, { prompt: 'edit' })).toThrow('reference');
    expect(() =>
      normalizeImageRequest(edit.key, {
        prompt: 'edit',
        imageUrls: Array.from({ length: 11 }, (_, i) => `https://assets.example/${i}.png`)
      })
    ).toThrow('At most 10');
    const wan = registryEntry('wan-2.7-image:text-to-image');
    expect(
      normalizeImageRequest(wan.key, { prompt: 'render', width: 1024, height: 768, n: 4, seed: 7 })
        .request.input
    ).toMatchObject({ size: { width: 1024, height: 768 }, n: 4, seed: 7 });
    expect(() =>
      normalizeImageRequest(wan.key, { prompt: 'render', width: 0, height: 768 })
    ).toThrow('positive integer');
    const gpt = registryEntry('gpt-image-2:text-to-image');
    expect(
      normalizeImageRequest(gpt.key, {
        prompt: 'render',
        width: 2304,
        height: 1536,
        resolution: '2K'
      }).request.input.size
    ).toBe('2304x1536');
    expect(() =>
      normalizeImageRequest(gpt.key, {
        prompt: 'render',
        width: 2305,
        height: 1536,
        resolution: '2K'
      })
    ).toThrow('divisible by 16');
  });
  test('REG-04B rejects every malformed runtime field kind before payload transformation', () => {
    const flux = registryEntry('flux-schnell:text-to-image');
    for (const [values, message] of [
      [{ prompt: { injected: true } }, 'prompt must be a string'],
      [{ prompt: null }, 'prompt must be a string'],
      [{ prompt: ['array'] }, 'prompt must be a string'],
      [{ prompt: 'render', n: '2' }, 'n must be an integer'],
      [{ prompt: 'render', n: 1.5 }, 'n must be an integer'],
      [{ prompt: 'render', n: Number.NaN }, 'n must be finite'],
      [
        { prompt: 'render', dimensions: { width: 1024, height: 1024 } },
        'dimensions is not supported'
      ],
      [{ prompt: 'render', unknownField: true }, 'unknownField is not supported']
    ] as const) {
      expect(() =>
        normalizeImageRequest(
          flux.key,
          values as unknown as Parameters<typeof normalizeImageRequest>[1]
        )
      ).toThrow(message);
    }

    expect(() =>
      normalizeImageRequest('seedream-4.5:text-to-image', {
        prompt: 'render',
        enableSafetyChecker: 'false'
      } as unknown as Parameters<typeof normalizeImageRequest>[1])
    ).toThrow('enableSafetyChecker must be boolean');
    expect(() =>
      normalizeImageRequest('kling-o3-image:text-to-image', {
        prompt: 'render',
        elements: [null]
      } as unknown as Parameters<typeof normalizeImageRequest>[1])
    ).toThrow('elements must contain objects');
  });
  test('REG-07 opts every image model out of the safety checker and toggles only audited families', () => {
    const safetyIds = new Set([
      'qwen-image-2.1',
      'seedream-5.0-flash',
      'seedream-5.0-flash-edit',
      'qwen-image-3',
      'qwen-image-3-pro',
      'seedream-4.5',
      'seedream-4.5-edit',
      'seedream-5.0-lite',
      'seedream-5.0-lite-edit',
      'seedream-5.0-pro',
      'seedream-5.0-pro-edit',
      'z-image'
    ]);
    for (const entry of IMAGE_REGISTRY_ENTRIES) {
      const values = minimumValidRequest(entry);
      const preview = normalizeImageRequest(entry.key, values);
      // Poyo ignores the field on pages that do not document it, so it is always sent as false.
      expect(preview.request.input.enable_safety_checker).toBe(false);
      if (safetyIds.has(entry.publicModelId)) {
        expect(entry.output.safetyChecker).toBe(true);
        expect(
          normalizeImageRequest(entry.key, { ...values, enableSafetyChecker: true }).request.input
            .enable_safety_checker
        ).toBe(true);
      } else {
        expect(entry.output.safetyChecker).toBe(false);
        expect(() =>
          normalizeImageRequest(entry.key, { ...values, enableSafetyChecker: true })
        ).toThrow('enableSafetyChecker is not supported for this workflow.');
      }
    }
  });
  test('REG-08 Seedream 5 Pro emits the current independent size defaults', () => {
    const ratios = ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'];
    for (const key of ['seedream-5.0-pro:text-to-image', 'seedream-5.0-pro-edit:image-edit']) {
      const entry = registryEntry(key);
      expect(entry.fields.find((field) => field.key === 'aspectRatio')).toMatchObject({
        apiKey: 'size',
        enum: ratios,
        default: '1:1',
        required: true
      });
      expect(entry.fields.find((field) => field.key === 'resolution')).toMatchObject({
        apiKey: 'resolution',
        enum: ['1K', '2K'],
        default: '1K',
        required: true
      });
      expect(entry.fields.find((field) => field.key === 'n')).toBeUndefined();
      expect(entry.output.counts).toBeNull();
      expect(entry.validation.conditionalRules).not.toContain(
        'size-is-one-of-resolution-ratio-or-custom'
      );
      expect(entry.limitations).toEqual([]);

      const minimum = normalizeImageRequest(entry.key, {
        prompt: 'dream',
        ...(entry.workflow === 'image-edit'
          ? { imageUrls: ['https://assets.example/reference.png'] }
          : {})
      }).request.input;
      expect(minimum).toMatchObject({
        size: '1:1',
        resolution: '1K',
        enable_safety_checker: false
      });
      expect(minimum).not.toHaveProperty('n');
      if (entry.workflow === 'image-edit')
        expect(minimum.image_urls).toEqual(['https://assets.example/reference.png']);

      const values = {
        prompt: 'dream',
        ...(entry.workflow === 'image-edit'
          ? { imageUrls: ['https://assets.example/reference.png'] }
          : {})
      };
      expect(() => normalizeImageRequest(entry.key, { ...values, n: 6 })).toThrow(
        'n is not supported'
      );
      expect(() => normalizeImageRequest(entry.key, values, [{ key: 'n', value: 6 }])).toThrow(
        'Expert override n is not supported by the current Seedream 5.0 Pro schema.'
      );
    }

    expect(
      normalizeImageRequest('seedream-5.0-pro:text-to-image', {
        prompt: 'dream',
        aspectRatio: '16:9',
        resolution: '2K'
      }).request.input
    ).toMatchObject({ size: '16:9', resolution: '2K' });

    const nonProExpert = normalizeImageRequest(
      'flux-2-pro:text-to-image',
      { prompt: 'dream', aspectRatio: '1:1', resolution: '1K' },
      [{ key: 'n', value: 6 }]
    );
    expect(nonProExpert.expertDiff).toEqual([{ key: 'n', status: 'unverified', value: 6 }]);
    expect(nonProExpert.request.input.n).toBe(6);
  });

  test('REG-08B preserves union-size neighbors and Flux.2 independent requirements', () => {
    for (const key of ['seedream-4.5:text-to-image', 'seedream-5.0-lite:text-to-image']) {
      expect(() =>
        normalizeImageRequest(key, {
          prompt: 'dream',
          aspectRatio: '1:1',
          resolution: key.includes('4.5') ? '2K' : '3K'
        })
      ).toThrow('not both');
      expect(() =>
        normalizeImageRequest(key, {
          prompt: 'dream',
          width: 1024,
          height: 1024,
          resolution: key.includes('4.5') ? '2K' : '3K'
        })
      ).toThrow('custom dimensions or resolution');
    }

    expect(() =>
      normalizeImageRequest('flux-2-pro:text-to-image', {
        prompt: 'dream',
        aspectRatio: '1:1'
      })
    ).toThrow('requires both');
    expect(() =>
      normalizeImageRequest('flux-2-pro:text-to-image', {
        prompt: 'dream',
        resolution: '1K'
      })
    ).toThrow('requires both');
    expect(
      normalizeImageRequest('flux-2-pro:text-to-image', {
        prompt: 'dream',
        aspectRatio: '1:1',
        resolution: '1K'
      }).request.input
    ).toMatchObject({ size: '1:1', resolution: '1K' });

    for (const [key, count] of [
      ['seedream-4.5:text-to-image', 3],
      ['seedream-5.0-lite:text-to-image', 4],
      ['flux-schnell:text-to-image', 2]
    ] as const) {
      const entry = registryEntry(key);
      expect(entry.fields.find((field) => field.key === 'n')).toBeDefined();
      expect(normalizeImageRequest(key, { prompt: 'dream', n: count }).request.input.n).toBe(count);
    }
  });
  test('REG-09 marks controlled unknown expert overrides and blocks protected/verified fields', () => {
    const key = 'flux-schnell:text-to-image';
    const preview = normalizeImageRequest(key, { prompt: 'studio' }, [
      { key: 'future_parameter', value: 3 }
    ]);
    expect(preview.expertDiff).toEqual([
      { key: 'future_parameter', status: 'unverified', value: 3 }
    ]);
    expect(preview.request.input.future_parameter).toBe(3);
    for (const protectedKey of ['model', 'callback_url', 'api_key', 'local_path'])
      expect(() =>
        normalizeImageRequest(key, { prompt: 'studio' }, [{ key: protectedKey, value: 'x' }])
      ).toThrow(RegistryValidationError);
    expect(() =>
      normalizeImageRequest(key, { prompt: 'studio' }, [{ key: 'prompt', value: 'override' }])
    ).toThrow('guided field');
    expect(() =>
      normalizeImageRequest(key, { prompt: 'studio' }, [
        { key: 'future_parameter', value: Number.NaN }
      ])
    ).toThrow('strict JSON');
    expect(() => normalizeImageRequest(key, { prompt: 'studio' }, [null] as unknown as [])).toThrow(
      'key/value objects'
    );
  });
  test('REG-01 seeds the versioned manifest and definitions into SQLite idempotently', () => {
    const database = new Database(':memory:', { strict: true });
    migrateDatabase(database);
    seedImageRegistry(database);
    seedImageRegistry(database);
    expect(
      database.query<{ count: number }, []>('SELECT COUNT(*) count FROM registry_versions').get()
        ?.count
    ).toBe(1);
    expect(
      database.query<{ count: number }, []>('SELECT COUNT(*) count FROM registry_entries').get()
        ?.count
    ).toBe(68);
    expect(
      database
        .query<{ manifest_hash: string }, []>('SELECT manifest_hash FROM registry_versions')
        .get()?.manifest_hash
    ).toBe(IMAGE_REGISTRY.manifestHash);
    database.close();
  });
  test('REG-11 Qwen Image 3 shares one model ID between text and reference generation', () => {
    expect(
      IMAGE_REGISTRY_ENTRIES.filter((entry) => entry.family === 'Qwen Image 3').map(
        (entry) => entry.key
      )
    ).toEqual([
      'qwen-image-3:text-to-image',
      'qwen-image-3:image-edit',
      'qwen-image-3-pro:text-to-image',
      'qwen-image-3-pro:image-edit'
    ]);

    const text = registryEntry('qwen-image-3-pro:text-to-image');
    expect(text.provider).toBe('Alibaba');
    expect(text.inputRoles).toEqual([
      expect.objectContaining({ role: 'reference', required: false, min: 0, max: 3 })
    ]);
    expect(text.fields.find((field) => field.key === 'aspectRatio')).toMatchObject({
      apiKey: 'size',
      enum: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9']
    });
    expect(text.fields.find((field) => field.key === 'resolution')).toMatchObject({
      enum: ['1K', '2K'],
      default: '1K'
    });
    expect(text.fields.find((field) => field.key === 'outputFormat')).toMatchObject({
      enum: ['png', 'jpeg'],
      default: 'png'
    });
    expect(text.fields.find((field) => field.key === 'promptExtend')).toMatchObject({
      apiKey: 'prompt_extend',
      kind: 'boolean',
      default: true
    });
    expect(text.fields.find((field) => field.key === 'negativePrompt')).toMatchObject({
      apiKey: 'negative_prompt',
      kind: 'text',
      max: 5000
    });
    expect(text.output.counts).toBeNull();

    expect(normalizeImageRequest(text.key, { prompt: 'poster' }).request).toEqual({
      model: 'qwen-image-3-pro',
      input: {
        prompt: 'poster',
        resolution: '1K',
        output_format: 'png',
        prompt_extend: true,
        enable_safety_checker: false
      }
    });
    expect(
      normalizeImageRequest(text.key, {
        prompt: 'poster',
        aspectRatio: '21:9',
        resolution: '2K',
        outputFormat: 'jpeg',
        negativePrompt: 'watermark',
        promptExtend: false,
        seed: 314159
      }).request.input
    ).toMatchObject({
      size: '21:9',
      resolution: '2K',
      output_format: 'jpeg',
      negative_prompt: 'watermark',
      prompt_extend: false,
      seed: 314159
    });

    // The page is one unified endpoint, so the reference mode keeps the shared zero lower bound
    // every other switching image page uses and caps the documented three references.
    const reference = registryEntry('qwen-image-3:image-edit');
    expect(reference.inputRoles).toEqual([
      expect.objectContaining({ role: 'reference', required: true, min: 0, max: 3 })
    ]);
    expect(() =>
      normalizeImageRequest(reference.key, {
        prompt: 'badge',
        imageUrls: Array.from({ length: 4 }, (_, index) => `https://assets.example/${index}.png`)
      })
    ).toThrow('At most 3 reference images are supported.');
    expect(() =>
      normalizeImageRequest(reference.key, {
        prompt: 'badge',
        imageUrls: ['https://a/b.png'],
        n: 2
      })
    ).toThrow('n is not supported');
  });

  test('REG-12 Grok Imagine Image 2.0 submits its ratio as aspect_ratio', () => {
    expect(
      IMAGE_REGISTRY_ENTRIES.filter((entry) => entry.family === 'Grok Imagine Image 2.0').map(
        (entry) => entry.key
      )
    ).toEqual(['grok-imagine-image-2.0:text-to-image', 'grok-imagine-image-2.0:image-edit']);

    const text = registryEntry('grok-imagine-image-2.0:text-to-image');
    expect(text.provider).toBe('xAI');
    expect(text.fields.find((field) => field.key === 'aspectRatio')).toMatchObject({
      apiKey: 'aspect_ratio',
      enum: ['1:1', '2:3', '3:2', '9:16', '16:9'],
      default: '1:1'
    });
    expect(text.fields.find((field) => field.key === 'quality')).toMatchObject({
      enum: ['low', 'medium'],
      default: 'medium'
    });
    expect(text.fields.find((field) => field.key === 'prompt')).toMatchObject({ max: 8000 });
    expect(text.output.counts).toEqual([1, 2, 3, 4]);
    expect(text.output.seed).toBe(false);

    const request = normalizeImageRequest(text.key, { prompt: 'perfume bottle' }).request;
    expect(request).toEqual({
      model: 'grok-imagine-image-2.0',
      input: {
        prompt: 'perfume bottle',
        aspect_ratio: '1:1',
        resolution: '1K',
        n: 1,
        quality: 'medium',
        enable_safety_checker: false
      }
    });
    expect(request.input).not.toHaveProperty('size');

    // Every other image page still names the shared field size, so the adapter stays keyed by apiKey.
    expect(
      normalizeImageRequest('grok-imagine-image:text-to-image', {
        prompt: 'perfume bottle',
        aspectRatio: '16:9'
      }).request.input
    ).toMatchObject({ size: '16:9' });

    const edit = registryEntry('grok-imagine-image-2.0:image-edit');
    expect(edit.inputRoles).toEqual([
      expect.objectContaining({ role: 'reference', required: true, min: 0, max: 3 })
    ]);
    expect(() =>
      normalizeImageRequest(edit.key, {
        prompt: 'swap the background',
        imageUrls: Array.from({ length: 4 }, (_, index) => `https://assets.example/${index}.png`)
      })
    ).toThrow('At most 3 reference images are supported.');
    expect(() =>
      normalizeImageRequest(edit.key, {
        prompt: 'swap the background',
        imageUrls: ['https://a/b.png'],
        quality: 'high'
      })
    ).toThrow('quality is unsupported');
    expect(() =>
      normalizeImageRequest(edit.key, {
        prompt: 'swap the background',
        imageUrls: ['https://a/b.png'],
        n: 5
      })
    ).toThrow('n exceeds maximum');
  });

  test('REG-10 records the now-available paired Kling O3 source evidence', () => {
    const entries = IMAGE_REGISTRY_ENTRIES.filter(
      (entry) => entry.provenance.pageSlug === 'kling-o3'
    );
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.provenance.jsonStatus === 'available')).toBe(true);
    expect(entries.every((entry) => entry.provenance.jsonSha256.length === 64)).toBe(true);
  });
  test('REG-10 retains unindexed duplicate schemas outside current selectors', () => {
    expect(IMAGE_AUDIT_RECORDS).toHaveLength(2);
    expect(IMAGE_AUDIT_RECORDS.every((record) => record.status === 'unindexed')).toBe(true);
    expect(IMAGE_REGISTRY_ENTRIES.some((entry) => entry.key.startsWith('unindexed:'))).toBe(false);
  });
});
