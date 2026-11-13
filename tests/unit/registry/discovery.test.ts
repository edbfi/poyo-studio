import { describe, expect, test } from 'bun:test';
import { indexedModelPages, missingIndexedModels } from '../../../scripts/registry-discovery';

describe('documentation model discovery', () => {
  const index = `
- [Overview](https://docs.poyo.ai/api-manual/image-series/overview.md)
- [New](https://docs.poyo.ai/api-manual/image-series/new-model.md)
- [Duplicate](https://docs.poyo.ai/api-manual/image-series/new-model.md)
- [Video](https://docs.poyo.ai/api-manual/video-series/seedance-2.5.md)
- [Audio](https://docs.poyo.ai/api-manual/music-series/generate-music.md)
- [Untrusted](https://other.example/api-manual/image-series/pretend.md)
`;
  test('finds unique image/video model pages without narrative or unrelated services', () => {
    expect(indexedModelPages(index)).toEqual([
      { modality: 'image', pageSlug: 'new-model' },
      { modality: 'video', pageSlug: 'seedance-2.5' }
    ]);
  });
  test('reports new pages even when all previously known pages remain present', () => {
    expect(missingIndexedModels(index, { image: [], video: ['seedance-2.5'] })).toEqual([
      { modality: 'image', pageSlug: 'new-model' }
    ]);
    expect(missingIndexedModels(index, { image: ['new-model'], video: ['seedance-2.5'] })).toEqual(
      []
    );
  });
});
