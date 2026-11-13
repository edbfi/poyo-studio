import { describe, expect, test } from 'bun:test';
import { normalizeImageRequest as image } from '../../../src/lib/features/registry/normalize';
import { normalizeVideoRequest as video } from '../../../src/lib/features/registry/normalize-video';

const img = 'https://assets.example/image.png';
const clip = 'https://assets.example/video.mp4';
const prompt = 'A bright garden';

describe('November image contracts from official model schemas', () => {
  test('Flux Klein separates generation and editing, output count, and explicit custom-size tier', () => {
    expect(
      image('flux-3-klein-edit:image-edit', {
        prompt,
        imageUrls: [img],
        width: 1536,
        height: 1024,
        resolution: '2K',
        n: 4
      }).request.input
    ).toMatchObject({ image_urls: [img], size: '1536x1024', resolution: '2K', n: 4 });
    expect(() => image('flux-3-klein:text-to-image', { prompt, imageUrls: [img] })).toThrow(
      'not supported'
    );
    expect(() => image('flux-3-klein-edit:image-edit', { prompt })).toThrow('reference');
    expect(() =>
      image('flux-3-klein:text-to-image', { prompt, width: 1536, height: 1024 })
    ).toThrow('matching resolution');
    expect(() =>
      image('flux-3-klein:text-to-image', { prompt, width: 128, height: 1024, resolution: '1K' })
    ).toThrow('at least 256');
  });
  test('fixed GPT variants accept only their documented parameters', () => {
    expect(
      image('gpt-image-2.5-fixed:image-edit', {
        prompt,
        imageUrls: [img],
        version: 'sunburst',
        resolution: '4K',
        aspectRatio: 'auto'
      }).request.input
    ).toMatchObject({ version: 'sunburst', resolution: '4K', size: 'auto' });
    expect(
      image('gpt-image-2.6-fixed:text-to-image', { prompt, version: 'flare', resolution: '2K' })
        .request.input.resolution
    ).toBe('2K');
    expect(() =>
      image('gpt-image-2.6-fixed:text-to-image', { prompt, outputFormat: 'webp' })
    ).toThrow('not supported');
    expect(() =>
      image('gpt-image-2.5-fixed:text-to-image', { prompt, width: 1024, height: 1024 })
    ).toThrow('not supported');
  });
  for (const variant of ['flare', 'sunburst'])
    test(`GPT 2.6 ${variant} supports custom/auto sizes and compression constraints`, () => {
      const key = `gpt-image-2.6-${variant}:image-edit`;
      expect(
        image(key, {
          prompt,
          imageUrls: [img],
          maskUrl: img,
          width: 1024,
          height: 1024,
          outputFormat: 'webp',
          outputCompression: 70,
          background: 'transparent',
          moderation: 'low',
          complexity: 'high'
        }).request.input
      ).toMatchObject({
        size: '1024x1024',
        output_compression: 70,
        mask_url: img,
        moderation: 'low',
        complexity: 'high'
      });
      expect(() => image(key, { prompt, imageUrls: [img], outputCompression: 70 })).toThrow(
        'compression'
      );
      expect(() =>
        image(key, { prompt, imageUrls: [img], background: 'transparent', outputFormat: 'jpeg' })
      ).toThrow('PNG or WebP');
    });
  test('Ideogram retains one primary image and independent references with masked/high precision limits', () => {
    expect(
      image('ideogram-v4.5-edit:image-edit', {
        prompt,
        imageUrls: [img],
        referenceImageUrls: [img, img],
        maskUrl: img,
        editPrecision: 'high'
      }).request.input
    ).toMatchObject({
      image_urls: [img],
      reference_image_urls: [img, img],
      mask_url: img,
      size: 'auto',
      edit_precision: 'high'
    });
    expect(() => image('ideogram-v4.5-edit:image-edit', { prompt, imageUrls: [img, img] })).toThrow(
      'At most 1'
    );
    expect(() =>
      image('ideogram-v4.5-edit:image-edit', {
        prompt,
        imageUrls: [img],
        maskUrl: img,
        referenceImageUrls: Array(4).fill(img)
      })
    ).toThrow('three references');
    expect(() =>
      image('ideogram-v4.5-edit:image-edit', {
        prompt,
        imageUrls: [img],
        editPrecision: 'high',
        width: 1024,
        height: 1024
      })
    ).toThrow('auto size');
    expect(() => image('ideogram-v4.5:text-to-image', { prompt, quality: 'very_low' })).toThrow(
      'unsupported'
    );
  });
  for (const id of ['mai-image-2.6', 'mai-image-2.6-flash'])
    test(`${id} preserves web search and validates custom sizes`, () => {
      expect(
        image(`${id}:image-edit`, { prompt, imageUrls: Array(5).fill(img), webSearch: true })
          .request.input
      ).toMatchObject({ enable_web_search: true, image_urls: Array(5).fill(img) });
      expect(() => image(`${id}:text-to-image`, { prompt, width: 512, height: 1024 })).toThrow(
        'at least 768'
      );
      expect(() => image(`${id}:text-to-image`, { prompt, width: 2048, height: 2048 })).toThrow(
        '2359296'
      );
    });
  test('MiniMax and Seedream auto size needs editing and transparency needs PNG', () => {
    expect(
      image('minimax-h3-image:image-edit', {
        prompt,
        imageUrls: [img],
        aspectRatio: 'auto'
      }).request.input
    ).toMatchObject({ size: 'auto', resolution: '2K', enable_prompt_expansion: true });
    expect(() => image('seedream-5.5:text-to-image', { prompt, aspectRatio: 'auto' })).toThrow();
    expect(
      image('seedream-5.5:image-edit', {
        prompt,
        imageUrls: [img],
        resolution: '1.5K',
        background: 'transparent'
      }).request.input
    ).toMatchObject({ resolution: '1.5K', background: 'transparent', output_format: 'png' });
    expect(() =>
      image('seedream-5.5:text-to-image', {
        prompt,
        background: 'transparent',
        outputFormat: 'jpeg'
      })
    ).toThrow();
  });
});

describe('November video contracts from official model schemas', () => {
  test('Flux Max accepts optional end frame and unique timeline keyframes', () => {
    expect(
      video('flux-3-max/image-to-video:image-to-video', { prompt, imageUrls: [img, img] }).request
        .input
    ).toMatchObject({ image_urls: [img, img], duration: 5, sound: true });
    expect(
      video('flux-3-max/keyframes-to-video:keyframe-to-video', {
        prompt,
        duration: 20,
        keyframes: [{ image_url: img, frame_index: 480 }]
      }).request.input
    ).toHaveProperty('keyframes');
    expect(() =>
      video('flux-3-max/keyframes-to-video:keyframe-to-video', {
        prompt,
        duration: 5,
        keyframes: [{ image_url: img, frame_index: 121 }]
      })
    ).toThrow('frame_index');
    expect(() =>
      video('flux-3-max/text-to-video:text-to-video', { prompt, imageUrls: [img] })
    ).toThrow();
  });
  test('Gemini 1.2 supports video-only references and prohibits editing generation fields', () => {
    expect(
      video('gemini-omni-1.2-flash:reference-to-video', {
        prompt,
        referenceVideoUrls: [clip],
        duration: 15
      }).request.input
    ).toMatchObject({ reference_video_urls: [clip], duration: 15 });
    expect(
      video('gemini-omni-1.2-flash:video-to-video', { prompt, videoUrl: clip }).request.input
    ).not.toHaveProperty('duration');
    expect(() =>
      video('gemini-omni-1.2-flash:image-to-video', { prompt, imageUrls: [img, img], duration: 11 })
    ).toThrow('10 seconds');
    expect(() =>
      video('gemini-omni-1.2-flash:video-to-video', { prompt, videoUrl: clip, aspectRatio: '16:9' })
    ).toThrow();
    expect(() => video('gemini-omni-1.2-flash:reference-to-video', { prompt })).toThrow(
      'reference media'
    );
  });
  for (const id of ['kling-4.0', 'kling-4.0-flash'])
    test(`${id} preserves subject shape and rejects material/edit conflicts`, () => {
      const elements = [{ element_input_urls: [img, img] }];
      expect(
        video(`${id}:reference-to-video`, { prompt, elements, imageUrls: [img] }).request.input
      ).toMatchObject({ kling_elements: elements, image_urls: [img] });
      expect(() =>
        video(`${id}:reference-to-video`, { prompt, elements: [{ element_input_urls: [img] }] })
      ).toThrow('2–4 images');
      expect(() =>
        video(`${id}:reference-to-video`, {
          prompt,
          elements: [{ name: 'wrong', element_input_urls: [img, img] }]
        })
      ).toThrow('exactly one');
      expect(() =>
        video(`${id}:reference-to-video`, {
          prompt,
          imageUrls: [img],
          referenceImageUrls: Array(10).fill(img)
        })
      ).toThrow('10 images');
      expect(() =>
        video(`${id}:video-edit`, { prompt, videoUrl: clip, imageUrls: [img] })
      ).toThrow();
      expect(() =>
        video(`${id}:image-to-video`, { prompt, imageUrls: [img], aspectRatio: '16:9' })
      ).toThrow();
    });
  test('Kling 4 multishot accepts 30 seconds and default shot durations, without requiring sound', () => {
    expect(
      video('kling-4.0:multi-shot-video', {
        multiPrompt: [{ prompt: 'one' }, { prompt: 'two', duration: 25 }],
        imageUrls: [img, img]
      }).request.input
    ).toMatchObject({ multi_prompt: [{ prompt: 'one' }, { prompt: 'two', duration: 25 }] });
    expect(() =>
      video('kling-4.0:multi-shot-video', { multiPrompt: [{ prompt: 'one', duration: 31 }] })
    ).toThrow('30');
    expect(() =>
      video('kling-4.0:video-edit', {
        prompt,
        videoUrl: clip,
        elements: [{ element_input_video_urls: [clip] }]
      })
    ).toThrow('image subjects only');
  });
  test('avatar has no sizing or duration; PixVerse image prompt limit and audio default are mode-specific', () => {
    expect(
      video('omnihuman-2.0:avatar-video', {
        imageUrls: [img],
        audioUrl: 'https://assets.example/audio.mp3'
      }).request.input
    ).toMatchObject({ image_urls: [img], audio_url: 'https://assets.example/audio.mp3' });
    expect(() => video('omnihuman-2.0:avatar-video', { imageUrls: [img] })).toThrow('audio');
    expect(
      video('pixverse-v6-max:image-to-video', { prompt, imageUrls: [img] }).request.input
    ).toMatchObject({ audio: false, duration: 5, resolution: '540p' });
    expect(() =>
      video('pixverse-v6-max:image-to-video', { prompt: 'x'.repeat(2049), imageUrls: [img] })
    ).toThrow('too long');
  });
  test('Vidu audio references need reference images and image mode omits generation controls', () => {
    expect(
      video('vidu-q4:reference-to-video', {
        prompt,
        referenceImageUrls: [img],
        referenceAudioUrls: ['https://assets.example/audio.mp3'],
        generateAudio: true
      }).request.input
    ).toMatchObject({
      reference_audio_urls: ['https://assets.example/audio.mp3'],
      generate_audio: true
    });
    expect(video('vidu-q4:image-to-video', { imageUrls: [img] }).request.input).not.toHaveProperty(
      'aspect_ratio'
    );
    expect(() =>
      video('vidu-q4:image-to-video', { imageUrls: [img], generateAudio: true })
    ).toThrow();
    expect(() =>
      video('vidu-q4:reference-to-video', {
        prompt,
        referenceAudioUrls: ['https://assets.example/audio.mp3']
      })
    ).toThrow('at least 1');
  });
});
