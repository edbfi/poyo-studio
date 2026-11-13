import { resolve } from 'node:path';
import { indexedModelPages } from './registry-discovery';
import {
  fetchRegistrySource,
  type RegistrySourceManifest,
  sourceCorpusSha256
} from './registry-evidence-lib';

// This bootstrap deliberately does not import the registry: a new page cannot have registry
// provenance until its official source records exist. Offline validation still rejects missing
// registry entries until the new contracts have been implemented and reviewed.
const outputPath = resolve('src/lib/features/registry/evidence/official-source-manifest.json');
const manifest = (await Bun.file(outputPath).json()) as RegistrySourceManifest;
let indexBody = '';
const index = await fetchRegistrySource(
  {
    id: 'index:llms',
    category: 'index',
    representation: 'text',
    url: 'https://docs.poyo.ai/llms.txt'
  },
  (body) => {
    indexBody = body;
  }
);
if (index.status !== 'available')
  throw new Error(`Documentation index returned ${index.httpStatus}.`);
const known = new Map(manifest.sources.map((source) => [source.id, source]));
const added: string[] = [];
for (const page of indexedModelPages(indexBody)) {
  for (const representation of ['markdown', 'json'] as const) {
    const id = `model:${page.modality}:${page.pageSlug}:${representation}`;
    if (known.has(id)) continue;
    const extension = representation === 'markdown' ? 'md' : 'json';
    const source = await fetchRegistrySource({
      id,
      category: 'model',
      representation,
      modality: page.modality,
      pageSlug: page.pageSlug,
      url: `https://docs.poyo.ai/api-manual/${page.modality}-series/${page.pageSlug}.${extension}`
    });
    if (source.status !== 'available' || (representation === 'json' && !source.structured))
      throw new Error(`New model evidence requires review: ${id} (${source.status}).`);
    known.set(id, source);
    added.push(id);
  }
}
known.set(index.id, index);
manifest.sources = [...known.values()].sort((left, right) => left.id.localeCompare(right.id));
manifest.corpusSha256 = sourceCorpusSha256(manifest.sources);
manifest.verifiedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
await Bun.write(resolve('src/lib/features/registry/evidence/documentation-index.txt'), indexBody);
await Bun.write(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `Captured ${added.length} new source records. Review and implement newly indexed contracts before refreshing fixtures or accepting registry validation.`
);
for (const id of added) console.log(id);
