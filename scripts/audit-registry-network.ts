import manifestJson from '../src/lib/features/registry/evidence/official-source-manifest.json';
import {
  fetchRegistrySource,
  type RegistrySourceEvidence,
  type RegistrySourceManifest,
  type RegistrySourceSpec,
  structuredDiff
} from './registry-evidence-lib';

const manifest = manifestJson as RegistrySourceManifest;

async function fetchAll(
  sources: readonly RegistrySourceEvidence[]
): Promise<RegistrySourceEvidence[]> {
  const pending = [...sources];
  const results: RegistrySourceEvidence[] = [];
  const workers = Array.from({ length: 8 }, async () => {
    while (pending.length) {
      const baseline = pending.shift();
      if (!baseline) return;
      const spec: RegistrySourceSpec = {
        id: baseline.id,
        category: baseline.category,
        representation: baseline.representation,
        url: baseline.url,
        ...(baseline.modality ? { modality: baseline.modality } : {}),
        ...(baseline.pageSlug ? { pageSlug: baseline.pageSlug } : {}),
        ...(baseline.reviewStatus ? { reviewStatus: baseline.reviewStatus } : {}),
        ...(baseline.reviewNote ? { reviewNote: baseline.reviewNote } : {})
      };
      results.push(await fetchRegistrySource(spec));
    }
  });
  await Promise.all(workers);
  return results.sort((left, right) => left.id.localeCompare(right.id));
}

const currentSources = await fetchAll(manifest.sources);
const currentById = new Map(currentSources.map((source) => [source.id, source]));
const statusChanges: Array<{ id: string; from: string; to: string; httpStatus: number }> = [];
const bodyDrift: Array<{ id: string; expected: string; actual: string }> = [];
const structuredChanges: Array<{ id: string; changes: string[] }> = [];
const ignoredRawHtmlDrift: string[] = [];
for (const baseline of manifest.sources) {
  const current = currentById.get(baseline.id);
  if (!current) continue;
  if (baseline.status !== current.status || baseline.httpStatus !== current.httpStatus)
    statusChanges.push({
      id: baseline.id,
      from: `${baseline.status}/${baseline.httpStatus}`,
      to: `${current.status}/${current.httpStatus}`,
      httpStatus: current.httpStatus
    });
  if (baseline.canonicalSha256 !== current.canonicalSha256)
    bodyDrift.push({
      id: baseline.id,
      expected: baseline.canonicalSha256,
      actual: current.canonicalSha256
    });
  else if (baseline.sha256 !== current.sha256 && baseline.canonicalization !== 'raw-body-v1')
    ignoredRawHtmlDrift.push(baseline.id);
  const changes = structuredDiff(baseline.structured, current.structured);
  if (changes.length) structuredChanges.push({ id: baseline.id, changes });
}

const indexBody = await fetch(
  manifest.sources.find((source) => source.id === 'index:llms')?.url ??
    'https://docs.poyo.ai/llms.txt'
).then(async (response) => {
  if (!response.ok) throw new Error(`Documentation index returned ${response.status}.`);
  return response.text();
});
function indexedPages(modality: 'image' | 'video'): Set<string> {
  return new Set(
    [...indexBody.matchAll(new RegExp(`${modality}-series/([^\\s)]+)\\.md`, 'g'))]
      .map((match) => match[1])
      .filter((value): value is string => Boolean(value))
  );
}
function baselinePages(modality: 'image' | 'video'): Set<string> {
  return new Set(
    manifest.sources
      .filter(
        (source) =>
          source.category === 'model' &&
          source.modality === modality &&
          source.representation === 'markdown'
      )
      .map((source) => source.pageSlug)
      .filter((value): value is string => Boolean(value))
  );
}
function pageDiff(modality: 'image' | 'video') {
  const indexed = indexedPages(modality);
  const baseline = baselinePages(modality);
  return {
    added: [...indexed].filter((page) => !baseline.has(page)).sort(),
    removed: [...baseline].filter((page) => !indexed.has(page)).sort()
  };
}

const pages = { image: pageDiff('image'), video: pageDiff('video') };
const hasDrift = Boolean(
  statusChanges.length ||
    bodyDrift.length ||
    structuredChanges.length ||
    pages.image.added.length ||
    pages.image.removed.length ||
    pages.video.added.length ||
    pages.video.removed.length
);
const report = {
  checkedAt: new Date().toISOString(),
  authenticated: false,
  paidCalls: 0,
  baseline: {
    registryVersion: manifest.registryVersion,
    verifiedAt: manifest.verifiedAt,
    sourceCount: manifest.sources.length,
    corpusSha256: manifest.corpusSha256
  },
  fetched: {
    sourceCount: currentSources.length,
    available: currentSources.filter((source) => source.status === 'available').length,
    unavailable: currentSources.filter((source) => source.status === 'unavailable').length,
    contradictory: currentSources.filter((source) => source.status === 'contradictory').length,
    unstructured: currentSources.filter((source) => source.status === 'unstructured').length
  },
  pages,
  statusChanges,
  bodyDrift,
  structuredChanges,
  ignoredRawHtmlDrift,
  result: hasDrift ? 'drift' : 'pass',
  note: 'Unauthenticated documentation audit only. Pricing compares canonical visible main text; volatile raw HTML metadata is not a failure.'
};
console.log(JSON.stringify(report, null, 2));
if (hasDrift) process.exit(1);
