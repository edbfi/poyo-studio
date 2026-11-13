import { liveCatalogModelSources, OFFICIAL_SOURCE_MANIFEST } from './evidence/source-evidence';
import type {
  FieldDefinition,
  ImageRegistryEntry,
  InputRole,
  RegistryProvenance,
  VideoRegistryEntry
} from './types';

function provenance(modelId: string): RegistryProvenance {
  const { json } = liveCatalogModelSources(modelId);
  return {
    pageSlug: `catalog:${modelId}`,
    markdownUrl: json.url,
    markdownSha256: json.sha256,
    jsonUrl: json.url,
    jsonStatus: json.status,
    jsonSha256: json.sha256,
    sourceManifestVersion: `${OFFICIAL_SOURCE_MANIFEST.version}:${OFFICIAL_SOURCE_MANIFEST.corpusSha256}`,
    verifiedAt: OFFICIAL_SOURCE_MANIFEST.verifiedAt,
    manualDecision:
      'Enabled official capability catalog contract; no dedicated indexed Markdown page. Both source links refer to the JSON capability contract.'
  };
}
const imageFormats = ['image/jpeg', 'image/png', 'image/webp'];
const reference = (required: boolean, max: number | null): InputRole => ({
  role: 'reference',
  required,
  min: required ? 1 : 0,
  max,
  mediaKind: 'image',
  formats: imageFormats
});
const text = (
  key: string,
  apiKey: string,
  required = false,
  defaultValue?: string
): FieldDefinition => ({
  key,
  apiKey,
  kind: 'text',
  level: 'common',
  required,
  ...(defaultValue === undefined ? {} : { default: defaultValue })
});
const flag = (key: string, apiKey: string, defaultValue: number): FieldDefinition => ({
  key,
  apiKey,
  kind: 'integer',
  level: 'advanced',
  min: 0,
  max: 1,
  default: defaultValue
});
const gptIds = [
  'gpt-image-1-official',
  'gpt-image-1-edit-official',
  'gpt-image-1.5-official',
  'gpt-image-1.5-edit-official'
];

export const LIVE_IMAGE_REGISTRY_ENTRIES: readonly ImageRegistryEntry[] = [
  ...gptIds.flatMap((id): ImageRegistryEntry[] =>
    (['text-to-image', 'image-edit'] as const).map((workflow) => {
      const fields: FieldDefinition[] = [
        {
          key: 'prompt',
          apiKey: 'prompt',
          kind: 'text',
          level: 'essential',
          required: true,
          max: 1000
        },
        { key: 'n', apiKey: 'n', kind: 'integer', level: 'common', min: 1, max: 4, default: 1 },
        {
          key: 'size',
          apiKey: 'size',
          kind: 'enum',
          level: 'common',
          enum: ['1024x1024', '1024x1536', '1536x1024'],
          default: '1024x1024'
        }
      ];
      return {
        key: `${id}:${workflow}`,
        provider: 'OpenAI',
        family: 'GPT Image Official',
        displayName: `${id} · ${workflow.replaceAll('-', ' ')}`,
        publicModelId: id,
        workflow,
        status: 'current',
        inputRoles:
          workflow === 'image-edit'
            ? [
                reference(true, null),
                {
                  role: 'mask',
                  required: false,
                  min: 0,
                  max: 1,
                  mediaKind: 'image',
                  formats: imageFormats
                }
              ]
            : [],
        fields,
        ui: { form: 'guided-image', fieldOrder: fields.map((field) => field.key) },
        output: {
          mediaKind: 'image',
          formats: ['png'],
          counts: [1, 2, 3, 4],
          customSize: false,
          seed: false,
          safetyChecker: false
        },
        validation: { conditionalRules: [] },
        payload: { adapter: 'image-input-v1' },
        response: { normalizer: 'poyo-task-image-v1', mediaKind: 'image' },
        limitations: [
          'The official capability catalog describes all four identifiers with the same generation/editing schema; editing uses reference images. Output format is provider-selected.'
        ],
        provenance: provenance(id)
      };
    })
  ),
  (() => {
    const id = 'poyo-ai/image-translator';
    const fields = [
      text('sourceLanguage', 'source_language', false, 'auto'),
      text('targetLanguage', 'target_language', true),
      flag('protectText', 'protect_text', 0),
      flag('synthesisOnImage', 'synthesis_on_image', 1),
      flag('translateOnImage', 'translate_on_image', 1)
    ];
    return {
      key: `${id}:image-edit`,
      provider: 'Poyo',
      family: 'Image Translator',
      displayName: 'Image Translator',
      publicModelId: id,
      workflow: 'image-edit' as const,
      status: 'current' as const,
      inputRoles: [reference(true, 1)],
      fields,
      ui: { form: 'guided-image' as const, fieldOrder: fields.map((field) => field.key) },
      output: {
        mediaKind: 'image' as const,
        formats: ['png', 'jpeg', 'webp'],
        counts: [1],
        customSize: false,
        seed: false,
        safetyChecker: false
      },
      validation: { conditionalRules: [] },
      payload: { adapter: 'image-input-v1' as const },
      response: { normalizer: 'poyo-task-image-v1' as const, mediaKind: 'image' as const },
      limitations: ['Translate text in one image. Output format is provider-selected.'],
      provenance: provenance(id)
    };
  })()
];

function video(
  id: string,
  family: string,
  fields: FieldDefinition[],
  apiKey: 'video_url' | 'video_urls' = 'video_url'
): VideoRegistryEntry {
  return {
    key: `${id}:video-to-video`,
    provider: id.startsWith('poyo-ai/') ? 'Poyo' : 'Google',
    family,
    displayName: family,
    publicModelId: id,
    workflow: 'video-to-video',
    status: 'current',
    inputRoles: [
      {
        role: 'source-video',
        required: true,
        min: 1,
        max: 1,
        mediaKind: 'video',
        formats: ['video/mp4', 'video/webm', 'video/quicktime'],
        requestKey: apiKey === 'video_url' ? 'videoUrl' : 'videoUrls',
        apiKey
      }
    ],
    fields,
    ui: { form: 'guided-video', fieldOrder: fields.map((field) => field.key) },
    output: {
      mediaKind: 'video',
      formats:
        id === 'poyo-ai/video-background-removal'
          ? ['mp4', 'webm', 'mov', 'mkv', 'gif']
          : ['mp4', 'webm', 'mov'],
      durations: null,
      resolutions: null,
      aspectRatios: null,
      seed: false,
      safetyChecker: false,
      audio: 'none'
    },
    validation: { conditionalRules: [] },
    payload: { adapter: 'video-input-v1' },
    response: { normalizer: 'poyo-task-video-v1', mediaKind: 'video' },
    limitations: [
      'Enabled official capability contract. Remote media constraints are validated by the provider.'
    ],
    provenance: provenance(id)
  };
}
export const LIVE_VIDEO_REGISTRY_ENTRIES: readonly VideoRegistryEntry[] = [
  {
    ...video('veo3.1-extend', 'VEO 3.1 Extend', [
      { key: 'prompt', apiKey: 'prompt', kind: 'text', level: 'essential', required: true, min: 1 },
      {
        key: 'duration',
        apiKey: 'duration',
        kind: 'integer',
        level: 'common',
        min: 1,
        max: 7,
        default: 7
      },
      {
        key: 'resolution',
        apiKey: 'resolution',
        kind: 'enum',
        level: 'common',
        enum: ['720p', '1080p'],
        default: '720p'
      },
      {
        key: 'aspectRatio',
        apiKey: 'aspect_ratio',
        kind: 'enum',
        level: 'common',
        enum: ['auto', '16:9', '9:16'],
        default: 'auto'
      },
      { key: 'sound', apiKey: 'sound', kind: 'boolean', level: 'common', default: true }
    ]),
    output: {
      mediaKind: 'video',
      formats: ['mp4'],
      durations: { min: 1, max: 7 },
      resolutions: ['720p', '1080p'],
      aspectRatios: ['auto', '16:9', '9:16'],
      seed: false,
      safetyChecker: false,
      audio: 'boolean-sound'
    }
  },
  video(
    'poyo-ai/video-translator',
    'Video Translator',
    [
      text('sourceLanguage', 'source_language', true),
      text('targetLanguage', 'target_language', true),
      flag('wyNeedText', 'wy_need_text', 1),
      {
        key: 'voiceRoleId',
        apiKey: 'voice_role_id',
        kind: 'integer',
        level: 'advanced',
        default: 0
      },
      flag('removeBgAudio', 'remove_bg_audio', 0)
    ],
    'video_urls'
  ),
  video('poyo-ai/video-background-removal', 'Video Background Removal', [
    {
      key: 'preserveAudio',
      apiKey: 'preserve_audio',
      kind: 'boolean',
      level: 'common',
      default: true
    },
    {
      key: 'backgroundColor',
      apiKey: 'background_color',
      kind: 'enum',
      level: 'common',
      enum: [
        'Transparent',
        'Black',
        'White',
        'Gray',
        'Red',
        'Green',
        'Blue',
        'Yellow',
        'Cyan',
        'Magenta',
        'Orange'
      ]
    },
    {
      key: 'outputContainerAndCodec',
      apiKey: 'output_container_and_codec',
      kind: 'enum',
      level: 'advanced',
      enum: [
        'mp4_h265',
        'mp4_h264',
        'webm_vp9',
        'mov_h265',
        'mov_proresks',
        'mkv_h265',
        'mkv_h264',
        'mkv_vp9',
        'gif'
      ],
      default: 'webm_vp9'
    }
  ]),
  video('poyo-ai/video-upscaler', 'Video Upscaler', [
    { key: 'scale', apiKey: 'scale', kind: 'number', level: 'common', min: 1, max: 8, default: 2 }
  ])
];
