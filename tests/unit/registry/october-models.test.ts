import { describe, expect, test } from 'bun:test';
import { initialGuidedValues } from '../../../src/lib/features/generation/studio-controller';
import {
  initialAutomaticFields,
  resolvedGuidedValues
} from '../../../src/lib/features/generation/studio-sizing';
import { imageCatalogue, videoCatalogue } from '../../../src/lib/features/registry/catalogue';
import { IMAGE_REGISTRY_ENTRIES } from '../../../src/lib/features/registry/image-registry';
import { normalizeImageRequest } from '../../../src/lib/features/registry/normalize';
import { normalizeVideoRequest } from '../../../src/lib/features/registry/normalize-video';

const image = 'https://assets.example/image.png';
const video = 'https://assets.example/video.mp4';
const audio = 'https://assets.example/audio.mp3';

// These expected wire payloads and invalid combinations are transcribed from the October
// documentation, independently of the generated registry fixture snapshots.
describe('October image model contracts', () => {
  test('required image and video prompts reject whitespace-only text', () => {
    expect(() =>
      normalizeImageRequest('seedream-5.0-flash:text-to-image', { prompt: '  ' })
    ).toThrow('prompt is required');
    expect(() => normalizeVideoRequest('h3-max:text-to-video', { prompt: '\n\t' })).toThrow(
      'prompt is required'
    );
  });
  test('Seedream Flash keeps size and its fractional resolution independent and emits one image', () => {
    expect(
      normalizeImageRequest('seedream-5.0-flash:text-to-image', {
        prompt: 'A flower shop poster',
        aspectRatio: '3:4',
        resolution: '1.5K',
        outputFormat: 'png'
      }).request
    ).toEqual({
      model: 'seedream-5.0-flash',
      input: {
        prompt: 'A flower shop poster',
        size: '3:4',
        resolution: '1.5K',
        output_format: 'png',
        enable_safety_checker: false
      }
    });
    expect(
      normalizeImageRequest('seedream-5.0-flash-edit:image-edit', {
        prompt: 'Combine these',
        imageUrls: Array(10).fill(image)
      }).request.input
    ).toMatchObject({ image_urls: Array(10).fill(image), size: '1:1', resolution: '1K' });
    expect(() =>
      normalizeImageRequest('seedream-5.0-flash-edit:image-edit', { prompt: 'edit' })
    ).toThrow('reference');
    expect(() =>
      normalizeImageRequest('seedream-5.0-flash-edit:image-edit', {
        prompt: 'edit',
        imageUrls: Array(11).fill(image)
      })
    ).toThrow('At most 10');
    expect(() =>
      normalizeImageRequest('seedream-5.0-flash:text-to-image', { prompt: 'poster' }, [
        { key: 'n', value: 2 }
      ])
    ).toThrow('not supported');
    expect(imageCatalogue('seedream-5.0-flash')).toHaveLength(2);
  });

  for (const variant of ['flare', 'sunburst']) {
    const model = `gpt-image-2.5-${variant}`;
    test(`${model} submits transparency, quality and masks using the same ID`, () => {
      expect(
        normalizeImageRequest(`${model}:image-edit`, {
          prompt: 'Replace the background',
          imageUrls: [image],
          maskUrl: image,
          background: 'transparent',
          outputFormat: 'webp',
          quality: 'xhigh',
          resolution: '4K'
        }).request
      ).toEqual({
        model,
        input: {
          prompt: 'Replace the background',
          image_urls: [image],
          mask_url: image,
          background: 'transparent',
          output_format: 'webp',
          quality: 'xhigh',
          resolution: '4K',
          size: '1:1',
          enable_safety_checker: false
        }
      });
      expect(() =>
        normalizeImageRequest(`${model}:image-edit`, {
          prompt: 'edit',
          imageUrls: Array(17).fill(image)
        })
      ).toThrow('At most 16');
      expect(() =>
        normalizeImageRequest(`${model}:text-to-image`, {
          prompt: 'cutout',
          background: 'transparent',
          outputFormat: 'jpeg'
        })
      ).toThrow('PNG or WebP');
      expect(() =>
        normalizeImageRequest(`${model}:text-to-image`, { prompt: 'edit', maskUrl: image })
      ).toThrow('Mask editing requires');
    });
    test(`${model} validates size/resolution dependencies and starts with valid studio defaults`, () => {
      const key = `${model}:text-to-image`;
      expect(() =>
        normalizeImageRequest(key, { prompt: 'poster', aspectRatio: 'auto', resolution: '2K' })
      ).toThrow('auto size requires 1K');
      expect(() =>
        normalizeImageRequest(key, { prompt: 'poster', width: 1024, height: 1024 })
      ).toThrow('require 2K or 4K');
      expect(() =>
        normalizeImageRequest(key, {
          prompt: 'poster',
          width: 3840,
          height: 2160,
          resolution: '2K'
        })
      ).toThrow('3840-pixel edge requires 4K');
      expect(
        normalizeImageRequest(key, {
          prompt: 'poster',
          width: 3840,
          height: 2160,
          resolution: '4K'
        }).request.input.size
      ).toBe('3840x2160');
      const entry = IMAGE_REGISTRY_ENTRIES.find((e) => e.key === key);
      if (!entry) throw new Error('Missing GPT Image 2.5');
      const values = resolvedGuidedValues(
        entry,
        { ...initialGuidedValues(entry), prompt: 'poster' },
        {},
        initialAutomaticFields(entry)
      );
      expect(normalizeImageRequest(key, values).request.input).toMatchObject({
        resolution: '4K',
        size: '1:1'
      });
    });
  }

  test('Nano Banana 2.1 uses one ID and limits auto ratio to reference editing', () => {
    expect(
      normalizeImageRequest('nano-banana-2.1:image-edit', {
        prompt: 'Watercolor garden',
        imageUrls: [image],
        aspectRatio: 'auto'
      }).request
    ).toEqual({
      model: 'nano-banana-2.1',
      input: {
        prompt: 'Watercolor garden',
        image_urls: [image],
        size: 'auto',
        resolution: '1K',
        enable_safety_checker: false
      }
    });
    expect(() =>
      normalizeImageRequest('nano-banana-2.1:text-to-image', { prompt: 'cat', aspectRatio: 'auto' })
    ).toThrow();
    expect(() =>
      normalizeImageRequest('nano-banana-2.1:image-edit', { prompt: 'cat', imageUrls: [] })
    ).toThrow('reference');
  });

  test('Qwen 2.1 enforces mask and transparency combinations and preserves an integer seed', () => {
    const key = 'qwen-image-2.1:image-edit';
    expect(
      normalizeImageRequest(key, {
        prompt: 'Blue cushion',
        imageUrls: [image],
        maskUrl: image,
        seed: -10
      }).request.input
    ).toMatchObject({
      mask_url: image,
      image_urls: [image],
      background: 'opaque',
      output_format: 'png',
      seed: -10
    });
    expect(() =>
      normalizeImageRequest(key, { prompt: 'edit', imageUrls: [image, image], maskUrl: image })
    ).toThrow('exactly one reference');
    expect(() =>
      normalizeImageRequest(key, {
        prompt: 'edit',
        imageUrls: [image],
        maskUrl: image,
        background: 'transparent'
      })
    ).toThrow('opaque background');
    expect(() =>
      normalizeImageRequest('qwen-image-2.1:text-to-image', {
        prompt: 'cutout',
        background: 'transparent',
        outputFormat: 'jpeg'
      })
    ).toThrow('PNG or WebP');
    expect(
      normalizeImageRequest('qwen-image-2.1:text-to-image', {
        prompt: 'cutout',
        background: 'transparent',
        outputFormat: 'webp'
      }).request.input.background
    ).toBe('transparent');
  });
});

describe('October video model contracts', () => {
  test('Gemini Omni exposes text, frames, references and source-video generation', () => {
    expect(videoCatalogue('gemini-omni-1.1-flash')).toHaveLength(4);
    expect(
      normalizeVideoRequest('gemini-omni-1.1-flash:text-to-video', { prompt: 'Neon city' }).request
        .input
    ).toEqual({
      prompt: 'Neon city',
      duration: 8,
      resolution: '720p',
      aspect_ratio: '16:9',
      enable_safety_checker: false
    });
    expect(
      normalizeVideoRequest('gemini-omni-1.1-flash:image-to-video', {
        prompt: 'Transition',
        imageUrls: [image, image]
      }).request.input.image_urls
    ).toHaveLength(2);
    const key = 'gemini-omni-1.1-flash:video-to-video';
    const input = normalizeVideoRequest(key, {
      prompt: 'Follow motion',
      referenceVideoUrls: [video],
      referenceImageUrls: Array(5).fill(image),
      referenceVideoDuration: 10
    }).request.input;
    expect(input).toMatchObject({
      reference_video_urls: [video],
      reference_image_urls: Array(5).fill(image)
    });
    expect(input).not.toHaveProperty('duration');
    expect(input).not.toHaveProperty('__local_reference_video_duration');
    expect(() =>
      normalizeVideoRequest(key, {
        prompt: 'motion',
        referenceVideoUrls: [video],
        referenceImageUrls: Array(6).fill(image)
      })
    ).toThrow('at most 5');
    expect(() =>
      normalizeVideoRequest(key, {
        prompt: 'motion',
        referenceVideoUrls: [video],
        referenceVideoDuration: 11
      })
    ).toThrow('exceeds maximum');
    expect(() =>
      normalizeVideoRequest('gemini-omni-1.1-flash:image-to-video', {
        prompt: 'motion',
        imageUrls: [image],
        referenceImageUrls: [image]
      })
    ).toThrow('not supported');
  });

  for (const model of ['h3-max', 'h3-max-turbo']) {
    test(`${model} accepts optional end frames without an aspect ratio`, () => {
      const key = `${model}:image-to-video`;
      expect(
        normalizeVideoRequest(key, {
          prompt: 'Daylight to sunset',
          imageUrls: [image, image],
          duration: 15,
          resolution: '1080p'
        }).request.input
      ).toEqual({
        prompt: 'Daylight to sunset',
        image_urls: [image, image],
        duration: 15,
        resolution: '1080p',
        enable_safety_checker: false
      });
      expect(() =>
        normalizeVideoRequest(key, { prompt: 'motion', imageUrls: [image], aspectRatio: '16:9' })
      ).toThrow('not supported');
      expect(() =>
        normalizeVideoRequest(key, { prompt: 'motion', imageUrls: [image] }, [
          { key: 'aspect_ratio', value: '16:9' }
        ])
      ).toThrow('not supported');
      expect(() =>
        normalizeVideoRequest(`${model}:text-to-video`, { prompt: 'motion', duration: 4 })
      ).toThrow('below minimum');
    });
  }

  test('H3 Max requires reference images and caps the combined reference count', () => {
    const key = 'h3-max:reference-to-video';
    expect(
      normalizeVideoRequest(key, {
        prompt: 'Image 1 follows Video 1',
        referenceImageUrls: [image],
        referenceVideoUrls: [video],
        referenceAudioUrls: [audio]
      }).request.input
    ).toMatchObject({
      aspect_ratio: 'adaptive',
      reference_image_urls: [image],
      reference_video_urls: [video],
      reference_audio_urls: [audio]
    });
    expect(() =>
      normalizeVideoRequest(key, { prompt: 'motion', referenceVideoUrls: [video] })
    ).toThrow('reference-image requires');
    expect(() =>
      normalizeVideoRequest(key, {
        prompt: 'motion',
        referenceImageUrls: Array(9).fill(image),
        referenceVideoUrls: Array(3).fill(video),
        referenceAudioUrls: [audio]
      })
    ).toThrow('at most 12 total');
  });

  test('Grok Video 1.5 has mode-specific durations, ratios and resolution limits', () => {
    expect(videoCatalogue('grok-imagine-video-1.5')).toHaveLength(3);
    expect(
      normalizeVideoRequest('grok-imagine-video-1.5:text-to-video', {
        prompt: 'motion',
        resolution: '1080p'
      }).request.input
    ).toMatchObject({ duration: 6, aspect_ratio: '16:9', resolution: '1080p' });
    expect(
      normalizeVideoRequest('grok-imagine-video-1.5:reference-to-video', {
        prompt: '<IMAGE_0> moves',
        referenceImageUrls: [image]
      }).request.input
    ).toMatchObject({ duration: 8, reference_image_urls: [image], resolution: '720p' });
    expect(() =>
      normalizeVideoRequest('grok-imagine-video-1.5:reference-to-video', {
        prompt: 'motion',
        referenceImageUrls: [image],
        resolution: '1080p'
      })
    ).toThrow('unsupported');
    expect(() =>
      normalizeVideoRequest('grok-imagine-video-1.5:image-to-video', {
        prompt: 'motion',
        imageUrls: [image],
        referenceImageUrls: [image]
      })
    ).toThrow('not supported');
  });

  test.each(['standard', 'pro'])('Kling Avatar %s requires image/audio but no prompt', (tier) => {
    const model = `kling-avatar-2.0/${tier}`;
    expect(
      normalizeVideoRequest(`${model}:avatar-video`, { imageUrls: [image], audioUrl: audio })
        .request
    ).toEqual({
      model,
      input: { image_urls: [image], audio_url: audio, enable_safety_checker: false }
    });
    expect(() => normalizeVideoRequest(`${model}:avatar-video`, { imageUrls: [image] })).toThrow(
      'audio requires'
    );
    expect(() =>
      normalizeVideoRequest(`${model}:avatar-video`, {
        imageUrls: [image],
        audioUrl: 'file:///tmp/audio.mp3'
      })
    ).toThrow('HTTP(S)');
  });
});
