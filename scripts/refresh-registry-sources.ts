import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  IMAGE_AUDIT_RECORDS,
  IMAGE_PAGE_SLUGS,
  IMAGE_REGISTRY_VERSION
} from '../src/lib/features/registry/image-registry';
import {
  VIDEO_AUDIT_RECORDS,
  VIDEO_PAGE_SLUGS,
  VIDEO_REGISTRY_VERSION
} from '../src/lib/features/registry/video-registry';
import {
  fetchRegistrySource,
  type RegistrySourceEvidence,
  type RegistrySourceManifest,
  type RegistrySourceSpec,
  sourceCorpusSha256
} from './registry-evidence-lib';

const outputPath = resolve('src/lib/features/registry/evidence/official-source-manifest.json');

function pairedOperationsSource(id: string, path: string): RegistrySourceSpec[] {
  return [
    {
      id: `operations:${id}:markdown`,
      category: 'operations',
      representation: 'markdown',
      url: `https://docs.poyo.ai/${path}.md`
    },
    {
      id: `operations:${id}:json`,
      category: 'operations',
      representation: 'json',
      url: `https://docs.poyo.ai/${path}.json`,
      ...(id === 'task-status'
        ? {
            reviewStatus: 'contradictory' as const,
            reviewNote:
              'The JSON file_type enum omits audio while the Markdown response contract includes it.'
          }
        : {})
    }
  ];
}

function sourceSpecs(): RegistrySourceSpec[] {
  const modelSources = [
    ...IMAGE_PAGE_SLUGS.flatMap((pageSlug) =>
      (['markdown', 'json'] as const).map((representation) => ({
        id: `model:image:${pageSlug}:${representation}`,
        category: 'model' as const,
        representation,
        modality: 'image' as const,
        pageSlug,
        url: `https://docs.poyo.ai/api-manual/image-series/${pageSlug}.${representation === 'markdown' ? 'md' : 'json'}`
      }))
    ),
    ...VIDEO_PAGE_SLUGS.flatMap((pageSlug) =>
      (['markdown', 'json'] as const).map((representation) => ({
        id: `model:video:${pageSlug}:${representation}`,
        category: 'model' as const,
        representation,
        modality: 'video' as const,
        pageSlug,
        url: `https://docs.poyo.ai/api-manual/video-series/${pageSlug}.${representation === 'markdown' ? 'md' : 'json'}`
      }))
    )
  ];
  const operations = [
    {
      id: 'operations:getting-started:markdown',
      category: 'operations' as const,
      representation: 'markdown' as const,
      url: 'https://docs.poyo.ai/.md'
    },
    {
      id: 'operations:generic-openapi:json',
      category: 'operations' as const,
      representation: 'json' as const,
      url: 'https://docs.poyo.ai/openapi.json',
      reviewStatus: 'contradictory' as const,
      reviewNote:
        'The generic submit schema permits fields and combinations narrowed by model-specific pages.'
    },
    ...pairedOperationsSource('overview', 'api-manual/overview'),
    ...pairedOperationsSource('error-codes', 'api-manual/error-codes'),
    ...pairedOperationsSource('task-status', 'api-manual/task-management/status'),
    ...pairedOperationsSource('webhooks', 'api-manual/task-management/webhooks'),
    ...pairedOperationsSource('balance', 'api-manual/account-management/user-balance'),
    ...pairedOperationsSource('upload-url', 'api-manual/file-series/upload-url'),
    ...pairedOperationsSource('upload-base64', 'api-manual/file-series/upload-base64'),
    ...pairedOperationsSource('upload-stream', 'api-manual/file-series/upload-stream'),
    {
      id: 'pricing:catalogue:html',
      category: 'pricing' as const,
      representation: 'html' as const,
      url: 'https://poyo.ai/pricing',
      reviewStatus: 'unstructured' as const,
      reviewNote:
        'Public catalogue only; no pricing-estimate API contract. Drift uses canonical visible main text rather than volatile HTML metadata.'
    }
  ];
  const auditOnly = [...IMAGE_AUDIT_RECORDS, ...VIDEO_AUDIT_RECORDS].map((record) => ({
    id: `audit:${record.key}`,
    category: 'audit-only' as const,
    representation: 'json' as const,
    url: record.sourceUrl,
    reviewNote: record.reason
  }));
  return [
    {
      id: 'index:llms',
      category: 'index',
      representation: 'text',
      url: 'https://docs.poyo.ai/llms.txt'
    },
    ...modelSources,
    ...operations,
    ...auditOnly
  ];
}

async function fetchAll(specs: readonly RegistrySourceSpec[]): Promise<RegistrySourceEvidence[]> {
  const pending = [...specs];
  const results: RegistrySourceEvidence[] = [];
  const workers = Array.from({ length: 8 }, async () => {
    while (pending.length) {
      const spec = pending.shift();
      if (!spec) return;
      results.push(await fetchRegistrySource(spec));
    }
  });
  await Promise.all(workers);
  return results.sort((left, right) => left.id.localeCompare(right.id));
}

const sources = await fetchAll(sourceSpecs());
const verifiedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const manifest: RegistrySourceManifest = {
  version: 1,
  registryVersion: `${IMAGE_REGISTRY_VERSION}+${VIDEO_REGISTRY_VERSION}`,
  verifiedAt,
  hashAlgorithm: 'sha256',
  corpusSha256: sourceCorpusSha256(sources),
  sources
};
await mkdir(dirname(outputPath), { recursive: true });
await Bun.write(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
const counts = Object.fromEntries(
  Object.entries(Object.groupBy(sources, (source) => source.status)).map(([key, value]) => [
    key,
    value?.length ?? 0
  ])
);
console.log(
  `Wrote ${sources.length} official source records to ${outputPath}; statuses=${JSON.stringify(counts)}; corpus=${manifest.corpusSha256}.`
);
