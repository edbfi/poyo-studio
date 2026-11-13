import { OFFICIAL_SOURCE_MANIFEST, officialModelSources } from './evidence/source-evidence';
import type { FieldDefinition, ImageRegistryEntry } from './types';

export const NOVEL_IMAGE_PAGE_SLUGS = ['ideogram-vector-1-0', 'seedream-5-5-layerize'];
const imageFormats = ['image/jpeg', 'image/png', 'image/webp'];
function makeEntry(
  slug: string,
  id: string,
  name: string,
  workflow: ImageRegistryEntry['workflow'],
  fields: FieldDefinition[],
  references: { required: boolean; min: number; max: number },
  formats: string[],
  counts: number[] | null
): ImageRegistryEntry {
  const sources = officialModelSources('image', slug);
  return {
    key: `${id}:${workflow}`,
    provider: slug.startsWith('ideogram') ? 'Ideogram' : 'ByteDance',
    family: name,
    displayName: name,
    publicModelId: id,
    workflow,
    status: 'current',
    inputRoles: [
      {
        role: 'reference',
        ...references,
        mediaKind: 'image',
        formats: slug.includes('layerize') ? imageFormats.slice(0, 2) : imageFormats
      }
    ],
    output: {
      mediaKind: 'image',
      formats,
      counts,
      customSize: false,
      seed: false,
      safetyChecker: slug.includes('layerize')
    },
    fields,
    ui: { form: 'guided-image', fieldOrder: fields.map((field) => field.key) },
    validation: { conditionalRules: [] },
    payload: { adapter: 'image-input-v1' },
    response: { normalizer: 'poyo-task-image-v1', mediaKind: 'image' },
    limitations: slug.includes('layerize')
      ? [
          'Returns a base image and up to max_images minus one transparent PNG layers, with optional OCR metadata. Input: JPEG or PNG up to 10 MB, 512–6000 pixels per edge, aspect ratio at most 16:1.'
        ]
      : [
          'Returns editable SVG files. Text generation references: up to 10 MB each. Image conversion: up to 50 MB.'
        ],
    provenance: {
      pageSlug: slug,
      markdownUrl: sources.markdown.url,
      markdownSha256: sources.markdown.sha256,
      jsonUrl: sources.json.url,
      jsonStatus: sources.json.status,
      jsonSha256: sources.json.sha256,
      sourceManifestVersion: `${OFFICIAL_SOURCE_MANIFEST.version}:${OFFICIAL_SOURCE_MANIFEST.corpusSha256}`,
      verifiedAt: OFFICIAL_SOURCE_MANIFEST.verifiedAt
    }
  };
}
export const NOVEL_IMAGE_ENTRIES: readonly ImageRegistryEntry[] = [
  makeEntry(
    'ideogram-vector-1-0',
    'ideogram-vector-1.0/text-to-vector',
    'Ideogram Vector 1.0',
    'text-to-image',
    [
      {
        key: 'prompt',
        apiKey: 'prompt',
        kind: 'text',
        level: 'essential',
        required: true,
        min: 1,
        max: 9500
      },
      {
        key: 'quality',
        apiKey: 'quality',
        kind: 'enum',
        level: 'common',
        enum: ['low', 'medium', 'high'],
        default: 'medium'
      },
      { key: 'n', apiKey: 'n', kind: 'integer', level: 'common', min: 1, max: 8, default: 1 },
      {
        key: 'aspectRatio',
        apiKey: 'size',
        kind: 'enum',
        level: 'common',
        enum: [
          'auto',
          '1:1',
          '1:4',
          '1:3',
          '1:2',
          '9:16',
          '10:16',
          '2:3',
          '3:4',
          '4:5',
          '5:4',
          '4:3',
          '3:2',
          '16:10',
          '16:9',
          '2:1',
          '3:1',
          '4:1'
        ],
        default: 'auto'
      }
    ],
    { required: false, min: 0, max: 5 },
    ['svg'],
    [1, 2, 3, 4, 5, 6, 7, 8]
  ),
  makeEntry(
    'ideogram-vector-1-0',
    'ideogram-vector-1.0/image-to-vector',
    'Ideogram Vector 1.0 Convert',
    'image-to-image',
    [
      {
        key: 'mode',
        apiKey: 'mode',
        kind: 'enum',
        level: 'common',
        enum: ['default', 'simple'],
        default: 'default'
      }
    ],
    { required: true, min: 1, max: 1 },
    ['svg'],
    [1]
  ),
  makeEntry(
    'seedream-5-5-layerize',
    'seedream-5.5-layerize',
    'Seedream 5.5 Layer Decomposition',
    'image-to-image',
    [
      { key: 'prompt', apiKey: 'prompt', kind: 'text', level: 'common', max: 2000 },
      {
        key: 'resolution',
        apiKey: 'resolution',
        kind: 'enum',
        level: 'common',
        enum: ['1K', '1.5K', '2K', 'auto'],
        default: 'auto'
      },
      {
        key: 'maxImages',
        apiKey: 'max_images',
        kind: 'integer',
        level: 'common',
        min: 2,
        max: 100,
        default: 30
      },
      {
        key: 'textRecognition',
        apiKey: 'text_recognition',
        kind: 'boolean',
        level: 'common',
        default: false
      },
      {
        key: 'outputFormat',
        apiKey: 'output_format',
        kind: 'enum',
        level: 'common',
        enum: ['png', 'jpeg'],
        default: 'png'
      },
      {
        key: 'enableSafetyChecker',
        apiKey: 'enable_safety_checker',
        kind: 'boolean',
        level: 'common',
        default: false
      }
    ],
    { required: true, min: 1, max: 1 },
    ['png', 'jpeg'],
    null
  )
];
