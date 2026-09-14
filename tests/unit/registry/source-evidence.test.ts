import { describe, expect, test } from 'bun:test';
import {
  canonicalizePricingHtml,
  extractStructuredOpenApi,
  type RegistrySourceManifest,
  sourceCorpusSha256,
  structuredDiff
} from '../../../scripts/registry-evidence-lib';
import manifestJson from '../../../src/lib/features/registry/evidence/official-source-manifest.json';

const manifest = manifestJson as unknown as RegistrySourceManifest;

describe('official registry source evidence', () => {
  test('pins the complete reviewed model and operations corpus', () => {
    expect(manifest.sources).toHaveLength(158);
    expect(sourceCorpusSha256(manifest.sources)).toBe(manifest.corpusSha256);

    const modelMarkdown = manifest.sources.filter(
      (source) => source.category === 'model' && source.representation === 'markdown'
    );
    const modelJson = manifest.sources.filter(
      (source) => source.category === 'model' && source.representation === 'json'
    );
    expect(modelMarkdown).toHaveLength(64);
    expect(modelJson).toHaveLength(64);
    expect(modelMarkdown.every((source) => source.status === 'available')).toBe(true);
    expect(modelJson.every((source) => source.status === 'available' && source.structured)).toBe(
      true
    );
    expect(
      manifest.sources
        .filter((source) => source.status === 'unavailable')
        .map((source) => source.id)
        .sort()
    ).toEqual([
      'operations:error-codes:json',
      'operations:overview:json',
      'operations:task-status:json',
      'operations:webhooks:json'
    ]);
  });

  test('extracts required fields, enums, defaults, formats, and bounds from OpenAPI', () => {
    const structured = extractStructuredOpenApi(
      JSON.stringify({
        openapi: '3.1.0',
        paths: { '/v1/tasks': { post: {} } },
        components: {
          schemas: {
            Input: {
              type: 'object',
              required: ['prompt'],
              properties: {
                prompt: { type: 'string', minLength: 3, maxLength: 1000 },
                output_format: {
                  type: 'string',
                  enum: ['png', 'jpeg'],
                  default: 'png'
                },
                references: {
                  type: 'array',
                  items: { type: 'string', format: 'uri' },
                  minItems: 1,
                  maxItems: 4
                },
                seed: { type: 'integer', minimum: 0, maximum: 2_147_483_647 }
              }
            }
          }
        }
      })
    );

    expect(structured?.paths).toEqual(['/v1/tasks']);
    expect(structured?.properties).toContainEqual({
      path: 'Input.prompt',
      type: 'string',
      required: true,
      minLength: 3,
      maxLength: 1000
    });
    expect(structured?.properties).toContainEqual({
      path: 'Input.output_format',
      type: 'string',
      required: false,
      enum: ['png', 'jpeg'],
      default: 'png'
    });
    expect(structured?.properties).toContainEqual({
      path: 'Input.references',
      type: 'array',
      required: false,
      minItems: 1,
      maxItems: 4
    });
    expect(structured?.properties).toContainEqual({
      path: 'Input.seed',
      type: 'integer',
      required: false,
      minimum: 0,
      maximum: 2_147_483_647
    });
  });

  test('reports structured contract drift instead of relying on an opaque body hash', () => {
    const baseline = {
      openapi: '3.1.0',
      paths: ['/v1/tasks'],
      properties: [{ path: 'Input.duration', type: 'integer', required: true, enum: [5, 10] }]
    };
    const current = {
      openapi: '3.1.0',
      paths: ['/v1/tasks', '/v1/tasks/{id}'],
      properties: [
        { path: 'Input.duration', type: 'integer', required: true, enum: [5, 10, 15] },
        { path: 'Input.sound', type: 'boolean', required: false }
      ]
    };

    expect(structuredDiff(baseline, current)).toEqual([
      'added path /v1/tasks/{id}',
      'changed property Input.duration',
      'added property Input.sound'
    ]);
  });

  test('canonicalizes visible pricing content while ignoring volatile page metadata', () => {
    const first =
      '<html><head><meta content="build-a"></head><body><main><h1>Pricing</h1><p>10 credits</p></main></body></html>';
    const second =
      '<html><head><meta content="build-b"></head><body><main> <h1>Pricing</h1> <p>10 credits</p> </main></body></html>';
    expect(canonicalizePricingHtml(first)).toBe(canonicalizePricingHtml(second));
    expect(canonicalizePricingHtml(first)).not.toBe(
      canonicalizePricingHtml(second.replace('10 credits', '12 credits'))
    );
  });
});
