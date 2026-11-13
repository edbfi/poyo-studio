import { expect, test } from 'bun:test';
import { normalizeImageRequest } from '../../../src/lib/features/registry/normalize';

test('vector conversion has no prompt and uses its dedicated mode', () => {
  const preview = normalizeImageRequest('ideogram-vector-1.0/image-to-vector:image-to-image', {
    imageUrls: ['https://example.com/input.png'],
    mode: 'simple'
  });
  expect(preview.request.input).toMatchObject({
    image_urls: ['https://example.com/input.png'],
    mode: 'simple'
  });
  expect(preview.request.input).not.toHaveProperty('prompt');
  expect(() =>
    normalizeImageRequest('ideogram-vector-1.0/image-to-vector:image-to-image', {
      imageUrls: ['https://example.com/input.png'],
      prompt: 'invalid'
    })
  ).toThrow();
});

test('layer decomposition accepts optional prompt and exposes max_images and OCR controls', () => {
  const preview = normalizeImageRequest('seedream-5.5-layerize:image-to-image', {
    imageUrls: ['https://example.com/input.png'],
    maxImages: 100,
    textRecognition: true
  });
  expect(preview.request.input).toMatchObject({
    image_urls: ['https://example.com/input.png'],
    max_images: 100,
    text_recognition: true
  });
  expect(preview.request.input).not.toHaveProperty('prompt');
  expect(() =>
    normalizeImageRequest('seedream-5.5-layerize:image-to-image', {
      imageUrls: ['https://example.com/input.png'],
      maxImages: 101
    })
  ).toThrow();
});
