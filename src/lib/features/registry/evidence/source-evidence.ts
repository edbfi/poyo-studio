import manifestJson from './official-source-manifest.json';

export type OfficialSourceStatus = 'available' | 'unavailable' | 'contradictory' | 'unstructured';

export interface OfficialSourceRecord {
  id: string;
  category: 'index' | 'model' | 'catalog' | 'operations' | 'pricing' | 'audit-only';
  representation: 'text' | 'markdown' | 'json' | 'html';
  url: string;
  modality?: 'image' | 'video';
  pageSlug?: string;
  status: OfficialSourceStatus;
  httpStatus: number;
  byteLength: number;
  sha256: string;
  canonicalSha256: string;
  canonicalization: 'raw-body-v1' | 'pricing-visible-text-v1';
  reviewNote?: string;
  structured: unknown;
}

export interface OfficialSourceManifest {
  version: 1;
  registryVersion: string;
  verifiedAt: string;
  hashAlgorithm: 'sha256';
  corpusSha256: string;
  sources: OfficialSourceRecord[];
}

export const OFFICIAL_SOURCE_MANIFEST = manifestJson as OfficialSourceManifest;

/** Capability-only models have one official JSON contract and no dedicated Markdown page. */
export function liveCatalogModelSources(modelId: string): {
  markdown: OfficialSourceRecord;
  json: OfficialSourceRecord;
} {
  const source = OFFICIAL_SOURCE_MANIFEST.sources.find(
    (candidate) => candidate.id === `catalog:${modelId}` && candidate.category === 'catalog'
  );
  if (!source) throw new Error(`Missing official capability evidence for ${modelId}.`);
  return { markdown: source, json: source };
}

export function officialModelSources(
  modality: 'image' | 'video',
  pageSlug: string
): { markdown: OfficialSourceRecord; json: OfficialSourceRecord } {
  const markdown = OFFICIAL_SOURCE_MANIFEST.sources.find(
    (source) =>
      source.category === 'model' &&
      source.modality === modality &&
      source.pageSlug === pageSlug &&
      source.representation === 'markdown'
  );
  const json = OFFICIAL_SOURCE_MANIFEST.sources.find(
    (source) =>
      source.category === 'model' &&
      source.modality === modality &&
      source.pageSlug === pageSlug &&
      source.representation === 'json'
  );
  if (!markdown || !json)
    throw new Error(`Missing official source evidence for ${modality}/${pageSlug}.`);
  return { markdown, json };
}
