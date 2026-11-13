import { describe, expect, test } from 'bun:test';
import { IMAGE_REGISTRY_ENTRIES } from '../../../src/lib/features/registry/image-registry';
import {
  highestResolutionToken,
  resolutionTier,
  supportedResolutionTokens
} from '../../../src/lib/features/registry/resolution-resolver';
import { VIDEO_REGISTRY_ENTRIES } from '../../../src/lib/features/registry/video-registry';

describe('resolutionTier', () => {
  test('ranks kilopixel tiers by their conventional frame height', () => {
    expect(resolutionTier('1K')).toBe(540);
    expect(resolutionTier('2K')).toBe(1080);
    expect(resolutionTier('4K')).toBe(2160);
    expect(resolutionTier('0.5K')).toBe(270);
  });
  test('ranks progressive-height tiers by their own number and ignores case', () => {
    expect(resolutionTier('480p')).toBe(480);
    expect(resolutionTier('768P')).toBe(768);
    expect(resolutionTier('1080p')).toBe(1080);
  });
  test('keeps a mixed catalogue ordered so 4k outranks 1080p', () => {
    expect(resolutionTier('4k')).toBeGreaterThan(resolutionTier('1080p') ?? 0);
  });
  test('rejects tokens that are not resolution tiers', () => {
    for (const token of ['auto', '', '1024x768', '16:9', 'K', '0K', '-2K', '2 KB'])
      expect(resolutionTier(token)).toBeNull();
  });
});

describe('highestResolutionToken', () => {
  test('returns the largest documented tier', () => {
    expect(highestResolutionToken(['1K', '2K'])).toBe('2K');
    expect(highestResolutionToken(['0.5K', '1K', '2K', '4K'])).toBe('4K');
    expect(highestResolutionToken(['480p', '720p', '1080p', '4k'])).toBe('4k');
    expect(highestResolutionToken(['512P', '768P'])).toBe('768P');
    expect(highestResolutionToken(['720p', '1024p', '1080p'])).toBe('1080p');
  });
  test('keeps the earliest token on an equal tier', () => {
    expect(highestResolutionToken(['2K', '1080p'])).toBe('2K');
  });
  test('skips unparseable members instead of returning them', () => {
    expect(highestResolutionToken(['auto', '720p', '1024x768'])).toBe('720p');
    expect(highestResolutionToken(['auto', '1024x768'])).toBeNull();
    expect(highestResolutionToken([])).toBeNull();
  });
});

describe('supportedResolutionTokens', () => {
  test('filters a registry enum down to tiers while preserving order', () => {
    expect(supportedResolutionTokens(['auto', '720p', '1024x768', '1080p'])).toEqual([
      '720p',
      '1080p'
    ]);
  });
  test('parses every explicit resolution tier while leaving automatic selection to the provider', () => {
    const tokens = [...IMAGE_REGISTRY_ENTRIES, ...VIDEO_REGISTRY_ENTRIES].flatMap(
      (entry) => entry.fields.find((field) => field.key === 'resolution')?.enum ?? []
    );
    expect(tokens.length).toBeGreaterThan(0);
    expect(supportedResolutionTokens(tokens)).toEqual(tokens.filter((token) => token !== 'auto'));
  });
});
