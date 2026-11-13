import { describe, expect, test } from 'bun:test';
import snapshotsJson from '../../../src/lib/features/registry/evidence/live-catalog-models.json';
import {
  LIVE_IMAGE_REGISTRY_ENTRIES,
  LIVE_VIDEO_REGISTRY_ENTRIES
} from '../../../src/lib/features/registry/live-catalog-registry';
import { normalizeRegistryRequest } from '../../../src/lib/features/registry/normalize-registry';

const entries = [...LIVE_IMAGE_REGISTRY_ENTRIES, ...LIVE_VIDEO_REGISTRY_ENTRIES];
const snapshots = snapshotsJson as Record<string, string>;

describe('enabled capability-only media contracts', () => {
  test('every guided API parameter and media role exists in its captured official schema', () => {
    for (const entry of entries) {
      const snapshot = JSON.parse(snapshots[`catalog:${entry.publicModelId}`] ?? '{}') as {
        data: { input_schema: { properties: Record<string, unknown> } };
      };
      const properties = snapshot.data.input_schema.properties;
      for (const field of entry.fields) expect(properties).toHaveProperty(field.apiKey);
      for (const role of entry.inputRoles)
        expect(properties).toHaveProperty(
          role.apiKey ?? (role.role === 'mask' ? 'mask_url' : 'image_urls')
        );
    }
  });
  test('translation submits numeric switches and language fields without inventing a prompt', () => {
    const image = normalizeRegistryRequest('poyo-ai/image-translator:image-edit', {
      imageUrls: ['https://example.com/image.png'],
      targetLanguage: 'en',
      protectText: 1
    });
    expect(image.request.input).toMatchObject({
      image_urls: ['https://example.com/image.png'],
      source_language: 'auto',
      target_language: 'en',
      protect_text: 1,
      synthesis_on_image: 1,
      translate_on_image: 1
    });
    expect(image.request.input).not.toHaveProperty('prompt');
    const video = normalizeRegistryRequest('poyo-ai/video-translator:video-to-video', {
      videoUrls: ['https://example.com/video.mp4'],
      sourceLanguage: 'de',
      targetLanguage: 'en'
    });
    expect(video.request.input).toMatchObject({
      video_urls: ['https://example.com/video.mp4'],
      source_language: 'de',
      target_language: 'en',
      wy_need_text: 1,
      remove_bg_audio: 0,
      voice_role_id: 0
    });
  });
  test('video extension enforces documented duration bounds before submission', () => {
    expect(() =>
      normalizeRegistryRequest('veo3.1-extend:video-to-video', {
        prompt: 'continue',
        videoUrl: 'https://example.com/video.mp4',
        duration: 8
      })
    ).toThrow();
    expect(
      normalizeRegistryRequest('veo3.1-extend:video-to-video', {
        prompt: 'continue',
        videoUrl: 'https://example.com/video.mp4'
      }).request.input.duration
    ).toBe(7);
  });
});
