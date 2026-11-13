import { expect, test } from 'bun:test';
import { parseStatusResponse } from '../../../src/lib/server/poyo/parsers';
import { createJobFixture } from '../../helpers/job-fixture';

test('layer decomposition preserves every returned image and layer placement/OCR metadata', async () => {
  const fixture = await createJobFixture();
  try {
    const job = fixture.repository.create({
      actionId: crypto.randomUUID(),
      publicModelId: 'seedream-5.5-layerize',
      workflow: 'image-to-image',
      guidedRequest: { imageUrls: ['https://example.com/poster.png'], maxImages: 4 },
      normalizedPayload: {
        model: 'seedream-5.5-layerize',
        input: { image_urls: ['https://example.com/poster.png'], max_images: 4 }
      }
    });
    const layer = {
      z_index: 1,
      name: 'Headline',
      bounding_box: { absolute: [0, 10, 100, 30], normalized: [0, 100, 1000, 300] },
      text_recognition: { text: 'Hello', lines: [] }
    };
    const status = parseStatusResponse({
      data: {
        task_id: 'layers',
        status: 'finished',
        credits_amount: 1,
        created_time: 'now',
        files: [
          { file_url: 'https://example.com/base.png', file_type: 'image', layer: { z_index: 0 } },
          { file_url: 'https://example.com/layer.png', file_type: 'image', layer }
        ]
      }
    });
    fixture.repository.applyStatus(job.id, status, 1000);
    const outputs = fixture.repository.outputs(job.id);
    expect(outputs).toHaveLength(2);
    const second = outputs[1];
    if (!second) throw new Error('Missing layer output.');
    const row = fixture.database
      .query<{ remote_metadata_json: string }, [string]>(
        'SELECT remote_metadata_json FROM job_outputs WHERE id=?'
      )
      .get(second.id);
    if (!row) throw new Error('Missing persisted layer metadata.');
    expect(JSON.parse(row.remote_metadata_json).layer).toEqual(layer);
    expect(fixture.repository.get(job.id)?.attentionCode).not.toBe('malformed_output_set');
  } finally {
    await fixture.cleanup();
  }
});

test('layer output cap is a maximum and still rejects excess files', async () => {
  const fixture = await createJobFixture();
  try {
    const job = fixture.repository.create({
      actionId: crypto.randomUUID(),
      publicModelId: 'seedream-5.5-layerize',
      workflow: 'image-to-image',
      guidedRequest: { maxImages: 2 },
      normalizedPayload: { model: 'seedream-5.5-layerize', input: { max_images: 2 } }
    });
    const status = parseStatusResponse({
      data: {
        task_id: 'layers',
        status: 'finished',
        credits_amount: 1,
        created_time: 'now',
        files: [1, 2, 3].map((n) => ({
          file_url: `https://example.com/${n}.png`,
          file_type: 'image',
          layer: { z_index: n - 1 }
        }))
      }
    });
    fixture.repository.applyStatus(job.id, status, 1000);
    expect(fixture.repository.outputs(job.id)).toHaveLength(0);
    expect(fixture.repository.get(job.id)?.attentionCode).toBe('malformed_output_set');
  } finally {
    await fixture.cleanup();
  }
});
