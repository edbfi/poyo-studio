import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { modelCatalogue, videoCatalogue } from '../../../src/lib/features/registry/catalogue';
import { normalizeRegistryRequest } from '../../../src/lib/features/registry/normalize-registry';
import {
  minimumValidVideoRequest,
  normalizeVideoRequest
} from '../../../src/lib/features/registry/normalize-video';
import type {
  GuidedVideoRequest,
  VideoRegistryEntry
} from '../../../src/lib/features/registry/types';
import {
  VIDEO_AUDIT_RECORDS,
  VIDEO_CURRENT_ENTRIES,
  VIDEO_EXCLUDED_ENTRIES,
  VIDEO_PAGE_SLUGS,
  VIDEO_PUBLIC_IDS,
  VIDEO_REGISTRY_ENTRIES
} from '../../../src/lib/features/registry/video-registry';
import { migrateDatabase } from '../../../src/lib/server/platform/database';
import { seedImageRegistry, seedVideoRegistry } from '../../../src/lib/server/registry/repository';

function videoEntry(key: string): VideoRegistryEntry {
  const entry = VIDEO_REGISTRY_ENTRIES.find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`Missing video registry fixture: ${key}`);
  return entry;
}

function minimum(key: string): GuidedVideoRequest {
  return minimumValidVideoRequest(videoEntry(key));
}

describe('audited video registry coverage', () => {
  test('REG-01/02 accounts for 43 pages, 69 IDs and 151 current workflows', () => {
    expect(VIDEO_PAGE_SLUGS).toHaveLength(43);
    expect(new Set(VIDEO_PAGE_SLUGS).size).toBe(43);
    expect(VIDEO_PUBLIC_IDS).toHaveLength(69);
    expect(VIDEO_CURRENT_ENTRIES).toHaveLength(151);
    expect(VIDEO_EXCLUDED_ENTRIES).toHaveLength(0);
    expect(VIDEO_AUDIT_RECORDS).toHaveLength(8);
    expect(VIDEO_AUDIT_RECORDS.filter((record) => record.status === 'legacy')).toHaveLength(2);
    expect(VIDEO_AUDIT_RECORDS.filter((record) => record.status === 'unindexed')).toHaveLength(6);
  });

  test('REG-03 normalizes a minimum exact request for every current video workflow', () => {
    for (const entry of VIDEO_CURRENT_ENTRIES) {
      const preview = normalizeVideoRequest(entry.key, minimumValidVideoRequest(entry));
      expect(preview.request.model).toBe(entry.publicModelId);
      expect(entry.ui.form).toBe('guided-video');
      expect(entry.payload.adapter).toBe('video-input-v1');
      expect(entry.response.normalizer).toBe('poyo-task-video-v1');
      expect(entry.provenance.markdownSha256).toHaveLength(64);
      expect(entry.provenance.jsonSha256).toHaveLength(64);
      expect(entry.provenance.jsonStatus).toBe('available');
      expect(entry.provenance.sourceManifestVersion).toMatch(/^1:[a-f0-9]{64}$/);
    }
  });

  test('REG-02 includes avatars and excludes legacy records from selectors', () => {
    expect(videoCatalogue('avatar')).toHaveLength(2);
    expect(videoCatalogue().every((entry) => entry.status === 'current')).toBe(true);
    expect(() => normalizeVideoRequest('kling-avatar-2.0/standard:avatar-video', {})).toThrow(
      'image requires at least 1 input'
    );
    expect(modelCatalogue('sora-2-beta')).toEqual([]);
  });

  test('REG-01 persists current, excluded and audit snapshots idempotently', () => {
    const database = new Database(':memory:', { strict: true });
    migrateDatabase(database);
    seedImageRegistry(database);
    seedVideoRegistry(database);
    seedVideoRegistry(database);
    expect(
      database.query<{ count: number }, []>('SELECT COUNT(*) count FROM registry_versions').get()
        ?.count
    ).toBe(2);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) count FROM registry_entries WHERE modality='video'"
        )
        .get()?.count
    ).toBe(159);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) count FROM registry_entries WHERE status='excluded-initial-scope'"
        )
        .get()?.count
    ).toBe(0);
    expect(
      database.query<{ count: number }, []>('SELECT COUNT(*) count FROM registry_entries').get()
        ?.count
    ).toBe(227);
    database.close();
  });
});

describe('reviewed video conditional adapters', () => {
  test('REG-04B rejects malformed scalar, structured and media role runtime kinds', () => {
    const textKey = 'happy-horse:text-to-video';
    const textValues = minimum(textKey);
    for (const [values, message] of [
      [{ ...textValues, prompt: { injected: true } }, 'prompt must be a string'],
      [{ ...textValues, prompt: null }, 'prompt must be a string'],
      [{ ...textValues, duration: '5' }, 'duration must be an integer'],
      [{ ...textValues, duration: Number.NaN }, 'duration must be finite'],
      [{ ...textValues, enableSafetyChecker: 'false' }, 'enableSafetyChecker must be boolean'],
      [{ ...textValues, unknownField: true }, 'unknownField is not supported']
    ] as const) {
      expect(() => normalizeVideoRequest(textKey, values as unknown as GuidedVideoRequest)).toThrow(
        message
      );
    }

    const imageKey = 'happy-horse:image-to-video';
    expect(() =>
      normalizeVideoRequest(imageKey, {
        ...minimum(imageKey),
        imageUrls: 'https://assets.example/source.png'
      } as unknown as GuidedVideoRequest)
    ).toThrow('imageUrls must be a list of strings');
    const frameKey = 'kling-2.6:frame-to-video';
    expect(() =>
      normalizeVideoRequest(frameKey, {
        ...minimum(frameKey),
        endImageUrl: ['https://assets.example/end.png']
      } as unknown as GuidedVideoRequest)
    ).toThrow('endImageUrl must be a string');
    const shotsKey = 'kling-3.0/pro:multi-shot-video';
    expect(() =>
      normalizeVideoRequest(shotsKey, {
        ...minimum(shotsKey),
        multiPrompt: [null]
      } as unknown as GuidedVideoRequest)
    ).toThrow('multiPrompt must contain objects');
  });

  test('REG-07 opts every video model out of the safety checker and toggles only audited families', () => {
    const safetyIds = new Set([
      'h3-max',
      'h3-max-turbo',
      'happy-horse-1.1',
      'happy-horse',
      'wan2.7-text-to-video',
      'wan2.7-image-to-video',
      'wan2.7-reference-to-video',
      'wan2.7-edit-video',
      'wan3.0-text-to-video',
      'wan3.0-image-to-video',
      'wan3.0-reference-to-video',
      'wan3.0-prime-text-to-video',
      'wan3.0-prime-image-to-video',
      'wan3.0-prime-reference-to-video'
    ]);
    for (const entry of VIDEO_CURRENT_ENTRIES) {
      const values = minimumValidVideoRequest(entry);
      const input = normalizeVideoRequest(entry.key, values).request.input;
      // Poyo ignores the field on pages that do not document it, so it is always sent as false.
      expect(input.enable_safety_checker).toBe(false);
      if (safetyIds.has(entry.publicModelId)) {
        expect(entry.output.safetyChecker).toBe(true);
        expect(entry.fields.find((field) => field.key === 'enableSafetyChecker')).toMatchObject({
          apiKey: 'enable_safety_checker',
          kind: 'boolean',
          default: false
        });
        expect(
          normalizeVideoRequest(entry.key, { ...values, enableSafetyChecker: true }).request.input
            .enable_safety_checker
        ).toBe(true);
      } else {
        expect(entry.output.safetyChecker).toBe(false);
        expect(() =>
          normalizeVideoRequest(entry.key, { ...values, enableSafetyChecker: true })
        ).toThrow('enableSafetyChecker is not supported for this workflow.');
      }
    }
  });

  test('REG-05 Kling 1.6 separates start/end/elements and cfg surfaces', () => {
    const proFrame = 'kling-1.6/pro:frame-to-video';
    expect(normalizeVideoRequest(proFrame, minimum(proFrame)).request.input).toMatchObject({
      start_image_url: expect.any(String),
      end_image_url: expect.any(String)
    });
    const standardReference = 'kling-1.6/standard:reference-to-video';
    expect(() =>
      normalizeVideoRequest(standardReference, { ...minimum(standardReference), cfgScale: 0.5 })
    ).toThrow('cfgScale is not supported');
    expect(
      VIDEO_REGISTRY_ENTRIES.some((entry) => entry.key === 'kling-1.6/standard:frame-to-video')
    ).toBe(false);
  });

  test('REG-05 Kling 2.6 fixes end-frame sound off without affecting other workflows', () => {
    const frame = 'kling-2.6:frame-to-video';
    expect(normalizeVideoRequest(frame, minimum(frame)).request.input.sound).toBe(false);
    expect(() => normalizeVideoRequest(frame, { ...minimum(frame), sound: true })).toThrow(
      'sound is not supported'
    );
    const text = 'kling-2.6:text-to-video';
    expect(normalizeVideoRequest(text, minimum(text)).request.input.sound).toBe(true);
  });

  test('REG-05 Kling 3/O3 multi-shot uses multi_prompt, matching duration, and sound', () => {
    for (const key of ['kling-3.0/pro:multi-shot-video', 'kling-o3/standard:multi-shot-video']) {
      const values = minimum(key);
      const input = normalizeVideoRequest(key, values).request.input;
      expect(input).toMatchObject({ multi_shots: true, sound: true });
      expect(input.multi_prompt).toBeArray();
      expect(input).not.toHaveProperty('prompt');
      expect(() => normalizeVideoRequest(key, { ...values, sound: false })).toThrow('sound=true');
      expect(() => normalizeVideoRequest(key, { ...values, prompt: 'conflict' })).toThrow(
        'prompt is not supported'
      );
      expect(() =>
        normalizeVideoRequest(key, {
          ...values,
          duration: 5,
          multiPrompt: [{ prompt: 'shot', duration: 4 }]
        })
      ).toThrow('must equal');
    }
  });

  test('REG-05 motion control validates roles, duration/orientation, and facial elements', () => {
    const motion26 = 'kling-2.6-motion-control:motion-control';
    expect(normalizeVideoRequest(motion26, minimum(motion26)).request.input).toMatchObject({
      image_urls: [expect.any(String)],
      video_urls: [expect.any(String)],
      character_orientation: 'image'
    });
    expect(() =>
      normalizeVideoRequest(motion26, {
        ...minimum(motion26),
        characterOrientation: 'image',
        referenceVideoDuration: 11
      })
    ).toThrow('through 10 seconds');
    const motion3 = 'kling-3.0-motion-control:motion-control';
    expect(() =>
      normalizeVideoRequest(motion3, {
        ...minimum(motion3),
        characterOrientation: 'image',
        elements: [{ name: 'face' }]
      })
    ).toThrow('video orientation');
  });

  test('REG-05 Happy Horse modes are mutually exclusive and edit omits duration', () => {
    const text = 'happy-horse:text-to-video';
    expect(() =>
      normalizeVideoRequest(text, {
        ...minimum(text),
        imageUrls: ['https://assets.example/image.png']
      })
    ).toThrow('imageUrls is not supported');
    const image = 'happy-horse:image-to-video';
    expect(() =>
      normalizeVideoRequest(image, {
        ...minimum(image),
        referenceImageUrls: ['https://assets.example/reference.png']
      })
    ).toThrow('referenceImageUrls is not supported');
    const edit = 'happy-horse:video-edit';
    const input = normalizeVideoRequest(edit, minimum(edit)).request.input;
    expect(input).not.toHaveProperty('duration');
    expect(input.audio_setting).toBe('auto');
  });

  test('REG-05 Hailuo enforces end-frame and 1080p duration matrices', () => {
    const frame = 'hailuo-02:frame-to-video';
    expect(() => normalizeVideoRequest(frame, { ...minimum(frame), resolution: '512P' })).toThrow(
      'requires 768P'
    );
    const hailuo23 = 'hailuo-2.3:text-to-video';
    expect(() =>
      normalizeVideoRequest(hailuo23, {
        ...minimum(hailuo23),
        resolution: '1080p',
        duration: 10
      })
    ).toThrow('6 seconds only');
  });

  test('REG-05 Hailuo 03 pins its 2K tier, per-mode ratios, and reference dependencies', () => {
    const text = videoEntry('hailuo-03:text-to-video');
    expect(text.provider).toBe('MiniMax');
    expect(text.fields.find((field) => field.key === 'prompt')).toMatchObject({
      required: true,
      min: 1,
      max: 2000
    });
    expect(text.fields.find((field) => field.key === 'duration')).toMatchObject({
      kind: 'integer',
      default: 5,
      min: 5,
      max: 15
    });
    expect(text.fields.find((field) => field.key === 'resolution')).toMatchObject({
      enum: ['2K'],
      default: '2K'
    });
    // Text generation never offers adaptive: the provider fails such a task at render time.
    expect(text.fields.find((field) => field.key === 'aspectRatio')).toMatchObject({
      enum: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
      default: '16:9'
    });
    expect(normalizeVideoRequest(text.key, minimum(text.key)).request).toEqual({
      model: 'hailuo-03',
      input: {
        prompt: 'studio video',
        duration: 5,
        aspect_ratio: '16:9',
        resolution: '2K',
        enable_safety_checker: false
      }
    });

    const image = videoEntry('hailuo-03:image-to-video');
    expect(image.fields.some((field) => field.key === 'aspectRatio')).toBe(false);
    expect(image.inputRoles).toEqual([
      expect.objectContaining({
        role: 'start-frame',
        apiKey: 'image_urls',
        required: true,
        min: 1,
        max: 2
      })
    ]);
    expect(() =>
      normalizeVideoRequest(image.key, { ...minimum(image.key), aspectRatio: '16:9' })
    ).toThrow('aspectRatio is not supported for this workflow');
    expect(() =>
      normalizeVideoRequest(image.key, minimum(image.key), [{ key: 'aspect_ratio', value: '16:9' }])
    ).toThrow('not supported for Hailuo 03 image-to-video');

    const reference = videoEntry('hailuo-03:reference-to-video');
    expect(reference.fields.find((field) => field.key === 'aspectRatio')).toMatchObject({
      enum: ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
      default: 'adaptive'
    });
    expect(reference.inputRoles.map((role) => [role.apiKey, role.max])).toEqual([
      ['reference_image_urls', 9],
      ['reference_video_urls', 3],
      ['reference_audio_urls', 3]
    ]);
    expect(() =>
      normalizeVideoRequest(reference.key, {
        ...minimum(reference.key),
        referenceImageUrls: [],
        referenceAudioUrls: ['https://assets.example/audio.mp3']
      })
    ).toThrow('requires a reference image or video');
    expect(
      normalizeVideoRequest(reference.key, {
        ...minimum(reference.key),
        referenceVideoUrls: ['https://assets.example/motion.mp4']
      }).request.input
    ).toMatchObject({
      aspect_ratio: 'adaptive',
      reference_image_urls: ['https://assets.example/reference.png'],
      reference_video_urls: ['https://assets.example/motion.mp4']
    });
  });

  test('REG-05 Seedance separates frames and references and validates audio dependencies/totals', () => {
    const reference = 'seedance-2:reference-to-video';
    expect(() =>
      normalizeVideoRequest(reference, {
        ...minimum(reference),
        referenceImageUrls: [],
        referenceAudioUrls: ['https://assets.example/audio.mp3']
      })
    ).toThrow('requires an image or video reference');
    expect(() =>
      normalizeVideoRequest(reference, {
        ...minimum(reference),
        referenceImageUrls: Array.from(
          { length: 9 },
          (_, index) => `https://assets.example/i-${index}.png`
        ),
        referenceVideoUrls: Array.from(
          { length: 3 },
          (_, index) => `https://assets.example/v-${index}.mp4`
        ),
        referenceAudioUrls: ['https://assets.example/audio.mp3']
      })
    ).toThrow('12 total');
    const image = 'seedance-2:image-to-video';
    expect(() =>
      normalizeVideoRequest(image, {
        ...minimum(image),
        referenceVideoUrls: ['https://assets.example/reference.mp4']
      })
    ).toThrow('referenceVideoUrls is not supported');
  });

  test('REG-05 Seedance 2 and 2 Mini expose image-to-video with an optional ending frame', () => {
    // Every Seedance 2 page documents image_urls as index 0 starting frame plus index 1 optional
    // ending frame, so the studio offers "Image to video", not a both-frames-required mode.
    for (const modelId of ['seedance-2', 'seedance-2-fast', 'seedance-2-mini']) {
      expect(
        VIDEO_CURRENT_ENTRIES.filter((entry) => entry.publicModelId === modelId).map(
          (entry) => entry.workflow
        )
      ).toEqual(['text-to-video', 'image-to-video', 'reference-to-video']);

      const key = `${modelId}:image-to-video`;
      expect(videoEntry(key).inputRoles).toEqual([
        expect.objectContaining({
          role: 'start-frame',
          requestKey: 'imageUrls',
          apiKey: 'image_urls',
          required: true,
          min: 1,
          max: 2
        })
      ]);

      // A lone starting frame is valid; the ending frame is genuinely optional.
      expect(
        normalizeVideoRequest(key, {
          ...minimum(key),
          imageUrls: ['https://assets.example/first.png']
        }).request.input
      ).toMatchObject({ image_urls: ['https://assets.example/first.png'] });

      // Supplying both frames keeps documented order: index 0 start, index 1 end.
      expect(
        normalizeVideoRequest(key, {
          ...minimum(key),
          imageUrls: ['https://assets.example/first.png', 'https://assets.example/last.png']
        }).request.input
      ).toMatchObject({
        image_urls: ['https://assets.example/first.png', 'https://assets.example/last.png']
      });

      // A third image exceeds the documented two-image cap.
      expect(() =>
        normalizeVideoRequest(key, {
          ...minimum(key),
          imageUrls: [
            'https://assets.example/first.png',
            'https://assets.example/last.png',
            'https://assets.example/extra.png'
          ]
        })
      ).toThrow('at most 2');
    }

    // Unlike Seedance 2.5, the 2 and 2 Mini pages do not pin image mode to aspect_ratio auto.
    expect(
      videoEntry('seedance-2:image-to-video').fields.find((field) => field.key === 'aspectRatio')
        ?.enum
    ).toEqual(['auto', '1:1', '21:9', '4:3', '3:4', '16:9', '9:16']);
  });

  test('REG-05 Seedance 2.5 pins its documented modes, auto image ratio, and wider reference matrix', () => {
    expect(
      VIDEO_CURRENT_ENTRIES.filter((entry) => entry.publicModelId === 'seedance-2.5').map(
        (entry) => entry.workflow
      )
    ).toEqual(['text-to-video', 'image-to-video', 'reference-to-video']);

    const text = videoEntry('seedance-2.5:text-to-video');
    expect(text.provider).toBe('ByteDance');
    expect(text.fields.find((field) => field.key === 'duration')).toMatchObject({
      kind: 'integer',
      required: true,
      default: 4,
      min: 4,
      max: 30
    });
    expect(text.fields.find((field) => field.key === 'resolution')).toMatchObject({
      required: true,
      enum: ['480p', '720p'],
      default: '720p'
    });
    expect(text.fields.find((field) => field.key === 'aspectRatio')?.enum).toEqual([
      'auto',
      '1:1',
      '21:9',
      '4:3',
      '3:4',
      '16:9',
      '9:16'
    ]);
    expect(normalizeVideoRequest(text.key, minimum(text.key)).request).toEqual({
      model: 'seedance-2.5',
      input: {
        prompt: 'studio video',
        duration: 4,
        aspect_ratio: 'auto',
        resolution: '720p',
        generate_audio: false,
        enable_safety_checker: false
      }
    });
    expect(() => normalizeVideoRequest(text.key, { ...minimum(text.key), duration: 31 })).toThrow(
      'exceeds maximum'
    );
    expect(() =>
      normalizeVideoRequest(text.key, { ...minimum(text.key), resolution: '1080p' })
    ).toThrow('resolution is unsupported');

    // A start frame plus an optional end frame share image_urls, and the page pins that mode to auto.
    const image = videoEntry('seedance-2.5:image-to-video');
    expect(image.inputRoles).toEqual([
      expect.objectContaining({
        role: 'start-frame',
        apiKey: 'image_urls',
        required: true,
        min: 1,
        max: 2
      })
    ]);
    expect(image.fields.find((field) => field.key === 'aspectRatio')).toMatchObject({
      enum: ['auto'],
      default: 'auto'
    });
    expect(
      normalizeVideoRequest(image.key, {
        ...minimum(image.key),
        imageUrls: ['https://assets.example/first.png', 'https://assets.example/last.png']
      }).request.input
    ).toMatchObject({
      aspect_ratio: 'auto',
      image_urls: ['https://assets.example/first.png', 'https://assets.example/last.png']
    });
    expect(() =>
      normalizeVideoRequest(image.key, { ...minimum(image.key), aspectRatio: '16:9' })
    ).toThrow('aspectRatio is unsupported');
    expect(() =>
      normalizeVideoRequest(image.key, {
        ...minimum(image.key),
        referenceImageUrls: ['https://assets.example/reference.png']
      })
    ).toThrow('referenceImageUrls is not supported');

    const reference = videoEntry('seedance-2.5:reference-to-video');
    expect(reference.inputRoles.map((role) => [role.apiKey, role.max])).toEqual([
      ['reference_image_urls', 30],
      ['reference_video_urls', 10],
      ['reference_audio_urls', 10]
    ]);
    expect(
      normalizeVideoRequest(reference.key, {
        ...minimum(reference.key),
        referenceVideoUrls: ['https://assets.example/motion.mp4'],
        referenceAudioUrls: ['https://assets.example/rhythm.wav']
      }).request.input
    ).toMatchObject({
      reference_image_urls: ['https://assets.example/reference.png'],
      reference_video_urls: ['https://assets.example/motion.mp4'],
      reference_audio_urls: ['https://assets.example/rhythm.wav']
    });
    expect(() =>
      normalizeVideoRequest(reference.key, {
        ...minimum(reference.key),
        referenceImageUrls: [],
        referenceAudioUrls: ['https://assets.example/rhythm.wav']
      })
    ).toThrow('requires an image or video reference');
    // The documented 50-file total is exactly the sum of the per-list caps, so a full corpus passes
    // and the per-list caps are what reject an oversized request.
    expect(
      Object.keys(
        normalizeVideoRequest(reference.key, {
          ...minimum(reference.key),
          referenceImageUrls: Array.from(
            { length: 30 },
            (_, index) => `https://assets.example/i-${index}.png`
          ),
          referenceVideoUrls: Array.from(
            { length: 10 },
            (_, index) => `https://assets.example/v-${index}.mp4`
          ),
          referenceAudioUrls: Array.from(
            { length: 10 },
            (_, index) => `https://assets.example/a-${index}.mp3`
          )
        }).request.input
      )
    ).toEqual(
      expect.arrayContaining([
        'reference_image_urls',
        'reference_video_urls',
        'reference_audio_urls'
      ])
    );
    expect(() =>
      normalizeVideoRequest(reference.key, {
        ...minimum(reference.key),
        referenceImageUrls: Array.from(
          { length: 31 },
          (_, index) => `https://assets.example/i-${index}.png`
        )
      })
    ).toThrow('reference-image supports at most 30 inputs');
    expect(() =>
      normalizeVideoRequest(reference.key, {
        ...minimum(reference.key),
        referenceVideoUrls: Array.from(
          { length: 11 },
          (_, index) => `https://assets.example/v-${index}.mp4`
        )
      })
    ).toThrow('reference-video supports at most 10 inputs');
  });

  test('REG-05 VEO derives generation_type and enforces model/duration restrictions', () => {
    const reference = 'veo3.1-fast-official:reference-to-video';
    expect(normalizeVideoRequest(reference, minimum(reference)).request.input).toMatchObject({
      generation_type: 'reference',
      duration: 8
    });
    expect(() => normalizeVideoRequest(reference, { ...minimum(reference), duration: 6 })).toThrow(
      'requires 8 seconds'
    );
    const liteFrame = 'veo3.1-lite-official:frame-to-video';
    expect(() =>
      normalizeVideoRequest(liteFrame, { ...minimum(liteFrame), resolution: '1080p', duration: 6 })
    ).toThrow('requires 8 seconds');
    expect(
      VIDEO_CURRENT_ENTRIES.some((entry) => entry.key === 'veo3.1-lite:reference-to-video')
    ).toBe(false);
    expect(
      VIDEO_CURRENT_ENTRIES.some((entry) => entry.key === 'veo3.1-quality:reference-to-video')
    ).toBe(false);
  });

  test('REG-05 Wan IDs keep mode-specific roles, durations, safety, and string audio', () => {
    expect(
      normalizeVideoRequest(
        'wan2.6-video-to-video:video-to-video',
        minimum('wan2.6-video-to-video:video-to-video')
      ).request.model
    ).toBe('wan2.6-video-to-video');
    expect(() =>
      normalizeVideoRequest('wan2.6-video-to-video:video-to-video', {
        ...minimum('wan2.6-video-to-video:video-to-video'),
        duration: 15
      })
    ).toThrow('unsupported');
    const text = 'wan2.7-text-to-video:text-to-video';
    const textWithoutPrompt = minimum(text);
    delete textWithoutPrompt.prompt;
    expect(() => normalizeVideoRequest(text, textWithoutPrompt)).toThrow('prompt is required');
    expect(
      normalizeVideoRequest(text, {
        ...minimum(text),
        audioUrl: 'https://assets.example/narration.mp3'
      }).request.input.audio_url
    ).toBe('https://assets.example/narration.mp3');
    const image = 'wan2.7-image-to-video:image-to-video';
    const imageEntry = videoEntry(image);
    expect(imageEntry.workflow).toBe('image-to-video');
    expect(imageEntry.inputRoles.map((role) => role.role)).toEqual([
      'start-frame',
      'source-video',
      'audio'
    ]);
    expect(imageEntry.output).toMatchObject({
      durations: { min: 2, max: 15 },
      resolutions: ['720p', '1080p'],
      aspectRatios: null,
      seed: true,
      safetyChecker: true
    });
    expect(imageEntry.fields.map((field) => field.key)).toEqual(
      expect.arrayContaining([
        'prompt',
        'duration',
        'resolution',
        'seed',
        'enableSafetyChecker',
        'multiShots'
      ])
    );
    expect(imageEntry.fields.map((field) => field.key)).not.toContain('aspectRatio');
    expect(
      VIDEO_REGISTRY_ENTRIES.filter((entry) => entry.publicModelId === 'wan2.7-image-to-video')
    ).toHaveLength(1);
    expect(
      VIDEO_REGISTRY_ENTRIES.some((entry) => entry.key === 'wan2.7-image-to-video:frame-to-video')
    ).toBe(false);
    const imageWithoutPrompt = minimum(image);
    delete imageWithoutPrompt.prompt;
    expect(
      normalizeVideoRequest(image, {
        ...imageWithoutPrompt,
        videoUrl: 'https://assets.example/motion.mp4',
        audioUrl: 'https://assets.example/soundtrack.mp3'
      }).request.input
    ).toMatchObject({
      image_urls: [expect.any(String)],
      video_url: 'https://assets.example/motion.mp4',
      audio_url: 'https://assets.example/soundtrack.mp3'
    });
    expect(normalizeVideoRequest(image, minimum(image)).request.input).not.toHaveProperty(
      'aspect_ratio'
    );
    expect(
      normalizeVideoRequest(image, {
        ...minimum(image),
        imageUrls: ['https://assets.example/start.png', 'https://assets.example/end.png'],
        duration: 15,
        resolution: '1080p',
        seed: 2147483647,
        enableSafetyChecker: true,
        multiShots: true
      }).request.input
    ).toMatchObject({
      image_urls: ['https://assets.example/start.png', 'https://assets.example/end.png'],
      duration: 15,
      resolution: '1080p',
      seed: 2147483647,
      enable_safety_checker: true,
      multi_shots: true
    });
    expect(() => normalizeVideoRequest(image, { ...minimum(image), aspectRatio: '16:9' })).toThrow(
      'aspectRatio is not supported'
    );
    expect(() =>
      normalizeVideoRequest(image, {
        ...minimum(image),
        imageUrls: [
          'https://assets.example/start.png',
          'https://assets.example/end.png',
          'https://assets.example/extra.png'
        ]
      })
    ).toThrow('supports at most 2 inputs');
    expect(() => normalizeVideoRequest(image, { ...minimum(image), duration: 1 })).toThrow(
      'below minimum'
    );
    expect(() => normalizeVideoRequest(image, { ...minimum(image), duration: 16 })).toThrow(
      'exceeds maximum'
    );
    expect(() => normalizeVideoRequest(image, { ...minimum(image), resolution: '480p' })).toThrow(
      'resolution is unsupported'
    );
    expect(() =>
      normalizeVideoRequest(image, minimum(image), [{ key: 'aspect_ratio', value: '16:9' }])
    ).toThrow('aspect_ratio is not supported');
    for (const key of [
      'wan2.7-reference-to-video:reference-to-video',
      'wan2.7-edit-video:video-edit'
    ]) {
      const values = minimum(key);
      delete values.prompt;
      expect(() => normalizeVideoRequest(key, values)).toThrow('prompt is required');
    }
    const edit = 'wan2.7-edit-video:video-edit';
    expect(() => normalizeVideoRequest(edit, { ...minimum(edit), duration: 1 })).toThrow(
      '0 or 2-10'
    );
    expect(normalizeVideoRequest(edit, minimum(edit)).request.input).toMatchObject({
      video_url: expect.any(String),
      duration: 0,
      enable_safety_checker: false
    });
    const wan25 = 'wan2.5-text-to-video:text-to-video';
    expect(
      normalizeVideoRequest(wan25, { ...minimum(wan25), audio: 'background_music' }).request.input
        .audio
    ).toBe('background_music');
    expect(() =>
      normalizeVideoRequest(wan25, {
        ...minimum(wan25),
        audio: true
      } as unknown as GuidedVideoRequest)
    ).toThrow('must be a string');
  });

  test('REG-05 Omni exposes one-image, three-image, and video modes without false duration', () => {
    expect(
      normalizeVideoRequest('omni-flash:image-to-video', minimum('omni-flash:image-to-video'))
        .request.input.image_urls
    ).toHaveLength(1);
    expect(
      normalizeVideoRequest(
        'omni-flash:image-fusion-video',
        minimum('omni-flash:image-fusion-video')
      ).request.input.image_urls
    ).toHaveLength(3);
    const video = 'omni-flash:video-to-video';
    expect(normalizeVideoRequest(video, minimum(video)).request.input).not.toHaveProperty(
      'duration'
    );
    expect(() => normalizeVideoRequest(video, { ...minimum(video), duration: 6 })).toThrow(
      'duration is not supported'
    );
  });

  test('REG-09 combined preview dispatch preserves expert safeguards', () => {
    const key = 'grok-imagine:text-to-video';
    const preview = normalizeRegistryRequest(key, minimum(key), [
      { key: 'future_video_parameter', value: 3 }
    ]);
    expect(preview.request.model).toBe('grok-imagine');
    expect(preview.expertDiff).toEqual([
      { key: 'future_video_parameter', status: 'unverified', value: 3 }
    ]);
    expect(() =>
      normalizeRegistryRequest(key, minimum(key), [{ key: 'api_key', value: 'secret' }])
    ).toThrow('protected');
    expect(() =>
      normalizeRegistryRequest(key, minimum(key), [
        { key: 'future_video_parameter', value: Number.NaN }
      ])
    ).toThrow('strict JSON');
    expect(() => normalizeRegistryRequest(key, minimum(key), [null] as unknown as [])).toThrow(
      'key/value objects'
    );
  });

  test('REG-05 Flux 3 splits its five model IDs into one media shape each', () => {
    expect(
      VIDEO_CURRENT_ENTRIES.filter((entry) => entry.family === 'Flux 3').map((entry) => [
        entry.publicModelId,
        entry.workflow
      ])
    ).toEqual([
      ['flux-3/text-to-video', 'text-to-video'],
      ['flux-3/image-to-video', 'image-to-video'],
      ['flux-3/first-last-frame-to-video', 'frame-to-video'],
      ['flux-3/extend-video', 'video-to-video'],
      ['flux-3/keyframes-to-video', 'keyframe-to-video']
    ]);

    const text = videoEntry('flux-3/text-to-video:text-to-video');
    expect(text.provider).toBe('Black Forest Labs');
    expect(text.inputRoles).toEqual([]);
    expect(text.fields.find((field) => field.key === 'duration')).toMatchObject({
      kind: 'integer',
      required: true,
      default: 5,
      min: 5,
      max: 20
    });
    expect(text.fields.find((field) => field.key === 'aspectRatio')).toMatchObject({
      apiKey: 'aspect_ratio',
      default: 'auto',
      enum: ['auto', '21:9', '2:1', '16:9', '4:3', '1:1', '3:4', '9:16']
    });
    expect(text.fields.find((field) => field.key === 'resolution')).toMatchObject({
      enum: ['720p', '1080p'],
      default: '720p'
    });
    expect(text.output.audio).toBe('boolean-sound');
    expect(normalizeVideoRequest(text.key, minimum(text.key)).request).toEqual({
      model: 'flux-3/text-to-video',
      input: {
        prompt: 'studio video',
        duration: 5,
        aspect_ratio: 'auto',
        resolution: '720p',
        sound: true,
        enable_safety_checker: false
      }
    });
    expect(() => normalizeVideoRequest(text.key, { ...minimum(text.key), duration: 21 })).toThrow(
      'exceeds maximum'
    );

    // One image starts a shot, two ordered images become the first and last frame.
    expect(videoEntry('flux-3/image-to-video:image-to-video').inputRoles).toEqual([
      expect.objectContaining({ apiKey: 'image_urls', required: true, min: 1, max: 1 })
    ]);
    const frames = videoEntry('flux-3/first-last-frame-to-video:frame-to-video');
    expect(frames.inputRoles).toEqual([
      expect.objectContaining({
        role: 'start-frame',
        apiKey: 'image_urls',
        required: true,
        min: 2,
        max: 2
      })
    ]);
    expect(() =>
      normalizeVideoRequest(frames.key, {
        ...minimum(frames.key),
        imageUrls: ['https://assets.example/start.png']
      })
    ).toThrow('start-frame requires at least 2 input');

    // Extending a video carries a single MP4 in video_url, not the plural list other pages use.
    const extend = videoEntry('flux-3/extend-video:video-to-video');
    expect(extend.inputRoles).toEqual([
      expect.objectContaining({
        role: 'source-video',
        requestKey: 'videoUrl',
        apiKey: 'video_url',
        required: true,
        min: 1,
        max: 1
      })
    ]);
    expect(normalizeVideoRequest(extend.key, minimum(extend.key)).request.input).toMatchObject({
      video_url: 'https://assets.example/source-video-0.mp4'
    });
  });

  test('REG-05 Flux 3 keyframes stay unique whole frames on the documented 24 fps timeline', () => {
    const entry = videoEntry('flux-3/keyframes-to-video:keyframe-to-video');
    expect(entry.inputRoles).toEqual([]);
    expect(entry.fields.find((field) => field.key === 'keyframes')).toMatchObject({
      apiKey: 'keyframes',
      kind: 'object-list',
      level: 'essential',
      required: true,
      min: 1,
      max: 10
    });

    const base = minimum(entry.key);
    expect(normalizeVideoRequest(entry.key, base).request).toEqual({
      model: 'flux-3/keyframes-to-video',
      input: {
        prompt: 'studio video',
        keyframes: [{ image_url: 'https://assets.example/keyframe.png', frame_index: 0 }],
        duration: 5,
        aspect_ratio: 'auto',
        resolution: '720p',
        sound: true,
        enable_safety_checker: false
      }
    });

    const keyframe = (frameIndex: number, name = 'frame') => ({
      image_url: `https://assets.example/${name}.png`,
      frame_index: frameIndex
    });
    expect(() => normalizeVideoRequest(entry.key, { ...base, keyframes: [] })).toThrow(
      'keyframes is required'
    );
    expect(() =>
      normalizeVideoRequest(entry.key, {
        ...base,
        keyframes: Array.from({ length: 11 }, (_, index) => keyframe(index, `frame-${index}`))
      })
    ).toThrow('keyframes has too many items');
    // duration 5 puts the last usable frame at 5 x 24.
    expect(() => normalizeVideoRequest(entry.key, { ...base, keyframes: [keyframe(121)] })).toThrow(
      'Each keyframe requires frame_index 0-120.'
    );
    expect(() =>
      normalizeVideoRequest(entry.key, { ...base, duration: 6, keyframes: [keyframe(121)] })
    ).not.toThrow();
    expect(() => normalizeVideoRequest(entry.key, { ...base, keyframes: [keyframe(1.5)] })).toThrow(
      'Each keyframe requires frame_index 0-120.'
    );
    expect(() =>
      normalizeVideoRequest(entry.key, {
        ...base,
        keyframes: [keyframe(0, 'a'), keyframe(0, 'b')]
      })
    ).toThrow('Keyframe frame_index values must be unique.');
    expect(() =>
      normalizeVideoRequest(entry.key, {
        ...base,
        keyframes: [{ image_url: 'ftp://assets.example/frame.png', frame_index: 0 }]
      })
    ).toThrow('keyframe requires HTTP(S) URLs without credentials.');
    expect(() =>
      normalizeVideoRequest(entry.key, {
        ...base,
        keyframes: [{ frame_index: 0 }]
      } as unknown as Parameters<typeof normalizeVideoRequest>[1])
    ).toThrow('Each keyframe requires an image_url.');
  });

  test('REG-05 Wan 3.0 and Prime share one submit contract across three model IDs', () => {
    expect(
      VIDEO_CURRENT_ENTRIES.filter((entry) => entry.family.startsWith('Wan 3.0')).map((entry) => [
        entry.family,
        entry.publicModelId,
        entry.workflow
      ])
    ).toEqual([
      ['Wan 3.0 Video', 'wan3.0-text-to-video', 'text-to-video'],
      ['Wan 3.0 Video', 'wan3.0-image-to-video', 'image-to-video'],
      ['Wan 3.0 Video', 'wan3.0-reference-to-video', 'reference-to-video'],
      ['Wan 3.0 Prime Video', 'wan3.0-prime-text-to-video', 'text-to-video'],
      ['Wan 3.0 Prime Video', 'wan3.0-prime-image-to-video', 'image-to-video'],
      ['Wan 3.0 Prime Video', 'wan3.0-prime-reference-to-video', 'reference-to-video']
    ]);

    const text = videoEntry('wan3.0-text-to-video:text-to-video');
    expect(text.provider).toBe('Alibaba');
    expect(text.inputRoles).toEqual([]);
    expect(text.fields.find((field) => field.key === 'prompt')).toMatchObject({
      required: true,
      min: 1,
      max: 20_000
    });
    expect(text.fields.find((field) => field.key === 'duration')).toMatchObject({
      kind: 'integer',
      required: true,
      default: 5,
      min: 2,
      max: 30
    });
    expect(text.fields.find((field) => field.key === 'aspectRatio')).toMatchObject({
      apiKey: 'aspect_ratio',
      default: 'adaptive',
      enum: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16']
    });
    expect(text.fields.find((field) => field.key === 'resolution')).toMatchObject({
      enum: ['480p', '720p', '1080p'],
      default: '720p'
    });
    // Both pages spell the output audio switch `audio`, not the `generate_audio` other pages use.
    expect(text.fields.find((field) => field.key === 'generateAudio')).toMatchObject({
      apiKey: 'audio',
      kind: 'boolean',
      default: true
    });
    expect(text.output.audio).toBe('boolean-generate');
    expect(normalizeVideoRequest(text.key, minimum(text.key)).request).toEqual({
      model: 'wan3.0-text-to-video',
      input: {
        prompt: 'studio video',
        duration: 5,
        aspect_ratio: 'adaptive',
        resolution: '720p',
        seed: 0,
        audio: true,
        enable_safety_checker: false
      }
    });
    expect(() => normalizeVideoRequest(text.key, { ...minimum(text.key), duration: 31 })).toThrow(
      'exceeds maximum'
    );
    expect(() => normalizeVideoRequest(text.key, { ...minimum(text.key), duration: 1 })).toThrow(
      'below minimum'
    );

    // Prime is the same contract under its own model IDs.
    const prime = videoEntry('wan3.0-prime-text-to-video:text-to-video');
    expect(prime.fields).toEqual(text.fields);
    expect(prime.inputRoles).toEqual(text.inputRoles);
    expect(prime.output).toEqual(text.output);
    expect(normalizeVideoRequest(prime.key, minimum(prime.key)).request.model).toBe(
      'wan3.0-prime-text-to-video'
    );
  });

  test('REG-05 Wan 3.0 image generation makes the end frame and the prompt optional', () => {
    for (const key of [
      'wan3.0-image-to-video:image-to-video',
      'wan3.0-prime-image-to-video:image-to-video'
    ]) {
      const entry = videoEntry(key);
      expect(entry.inputRoles).toEqual([
        expect.objectContaining({
          role: 'start-frame',
          requestKey: 'imageUrls',
          apiKey: 'image_urls',
          required: true,
          min: 1,
          max: 2
        })
      ]);
      expect(entry.fields.find((field) => field.key === 'prompt')).toMatchObject({
        required: false
      });

      const base = minimum(key);
      const { prompt: _prompt, ...withoutPrompt } = base;
      expect(normalizeVideoRequest(key, withoutPrompt).request.input.prompt).toBeUndefined();
      expect(
        normalizeVideoRequest(key, {
          ...base,
          imageUrls: ['https://assets.example/first.png', 'https://assets.example/last.png']
        }).request.input.image_urls
      ).toEqual(['https://assets.example/first.png', 'https://assets.example/last.png']);
      expect(() =>
        normalizeVideoRequest(key, {
          ...base,
          imageUrls: [
            'https://assets.example/first.png',
            'https://assets.example/middle.png',
            'https://assets.example/last.png'
          ]
        })
      ).toThrow('start-frame supports at most 2 inputs');
      expect(() => normalizeVideoRequest(key, { ...base, imageUrls: [] })).toThrow(
        'start-frame requires at least 1 input'
      );
    }
  });

  test('REG-05 Wan 3.0 reference generation caps each list and refuses an empty request', () => {
    for (const key of [
      'wan3.0-reference-to-video:reference-to-video',
      'wan3.0-prime-reference-to-video:reference-to-video'
    ]) {
      const entry = videoEntry(key);
      expect(
        entry.inputRoles.map((role) => [role.role, role.apiKey, role.required, role.min, role.max])
      ).toEqual([
        ['reference-image', 'reference_image_urls', false, 0, 10],
        ['reference-video', 'reference_video_urls', false, 0, 5],
        ['reference-audio', 'reference_audio_urls', false, 0, 5]
      ]);
      expect(entry.validation.conditionalRules).toEqual(['wan-3.0-reference-requires-media']);

      const base = minimum(key);
      expect(normalizeVideoRequest(key, base).request.input.reference_image_urls).toEqual([
        'https://assets.example/reference.png'
      ]);
      // Any one of the three exposed lists satisfies the rule; none of them does not.
      const { referenceImageUrls: _images, ...bare } = base;
      expect(() => normalizeVideoRequest(key, bare)).toThrow(
        'Wan 3.0 reference mode requires reference media.'
      );
      expect(() =>
        normalizeVideoRequest(key, {
          ...bare,
          referenceVideoUrls: ['https://assets.example/motion.mp4']
        })
      ).not.toThrow();
      expect(() =>
        normalizeVideoRequest(key, {
          ...bare,
          referenceAudioUrls: ['https://assets.example/rhythm.mp3']
        })
      ).not.toThrow();
      expect(() =>
        normalizeVideoRequest(key, {
          ...base,
          referenceVideoUrls: Array.from(
            { length: 6 },
            (_, index) => `https://assets.example/motion-${index}.mp4`
          )
        })
      ).toThrow('reference-video supports at most 5 inputs');
      // The documented document and webpage reference lists are not offered as media roles.
      expect(() =>
        normalizeVideoRequest(key, {
          ...base,
          imageUrls: ['https://assets.example/first.png']
        })
      ).toThrow('imageUrls is not supported for this workflow.');
    }
  });
});
