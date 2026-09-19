import sourceManifestJson from '../src/lib/features/registry/evidence/official-source-manifest.json';
import conditionalJson from '../src/lib/features/registry/evidence/reviewed-conditional-vectors.json';
import conflictsJson from '../src/lib/features/registry/evidence/reviewed-conflicts.json';
import imageFixturesJson from '../src/lib/features/registry/evidence/reviewed-image-fixtures.json';
import videoFixturesAMJson from '../src/lib/features/registry/evidence/reviewed-video-fixtures-a-m.json';
import videoFixturesNZJson from '../src/lib/features/registry/evidence/reviewed-video-fixtures-n-z.json';
import {
  IMAGE_PAGE_SLUGS,
  IMAGE_PUBLIC_IDS,
  IMAGE_REGISTRY,
  IMAGE_REGISTRY_ENTRIES,
  IMAGE_REGISTRY_VERSION
} from '../src/lib/features/registry/image-registry';
import { normalizeImageRequest } from '../src/lib/features/registry/normalize';
import { normalizeVideoRequest } from '../src/lib/features/registry/normalize-video';
import type {
  GuidedImageRequest,
  GuidedVideoRequest,
  ImageRegistryEntry,
  NormalizedPreview,
  VideoRegistryEntry
} from '../src/lib/features/registry/types';
import {
  VIDEO_AUDIT_RECORDS,
  VIDEO_CURRENT_ENTRIES,
  VIDEO_EXCLUDED_ENTRIES,
  VIDEO_PAGE_SLUGS,
  VIDEO_PUBLIC_IDS,
  VIDEO_REGISTRY,
  VIDEO_REGISTRY_ENTRIES,
  VIDEO_REGISTRY_VERSION
} from '../src/lib/features/registry/video-registry';
import { type RegistrySourceManifest, sourceCorpusSha256 } from './registry-evidence-lib';

type RegistryEntry = ImageRegistryEntry | VideoRegistryEntry;

interface FixtureWorkflow {
  entryKey: string;
  status: RegistryEntry['status'];
  source: { pageSlug: string; markdownId: string; jsonId: string };
  schema: Record<string, unknown>;
  vectors: null | {
    minimum: { values: Record<string, unknown>; request: NormalizedPreview['request'] };
    advanced: {
      values: Record<string, unknown>;
      request: NormalizedPreview['request'];
      coveredFields: string[];
    };
    invalid: { label: string; values: Record<string, unknown>; issueIncludes: string };
  };
  manualDecisions: string[];
}

interface FixtureFile {
  version: 1;
  registryVersion: string;
  reviewedAt: string;
  workflows: FixtureWorkflow[];
}

interface ConditionalFixture {
  rule: string;
  entryKey: string;
  values: Record<string, unknown>;
  issueIncludes: string;
}

const errors: string[] = [];
const sourceManifest = sourceManifestJson as RegistrySourceManifest;
const fixtureFiles = [
  imageFixturesJson as FixtureFile,
  videoFixturesAMJson as FixtureFile,
  videoFixturesNZJson as FixtureFile
];
const fixtures = fixtureFiles.flatMap((file) => file.workflows);
const conditionalFixtures = conditionalJson.vectors as ConditionalFixture[];
const entries = [...IMAGE_REGISTRY_ENTRIES, ...VIDEO_REGISTRY_ENTRIES];

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalize(entry: RegistryEntry, values: Record<string, unknown>): NormalizedPreview {
  return entry.output.mediaKind === 'image'
    ? normalizeImageRequest(entry.key, values as GuidedImageRequest)
    : normalizeVideoRequest(entry.key, values as GuidedVideoRequest);
}

function liveSchema(entry: RegistryEntry): Record<string, unknown> {
  return {
    publicModelId: entry.publicModelId,
    workflow: entry.workflow,
    fields: entry.fields,
    inputRoles: entry.inputRoles,
    output: entry.output,
    validation: entry.validation,
    payload: entry.payload,
    limitations: entry.limitations
  };
}

function expectRejection(
  entry: RegistryEntry,
  values: Record<string, unknown>,
  issueIncludes: string,
  label: string
): void {
  try {
    normalize(entry, values);
    errors.push(`${entry.key} accepted invalid fixture ${label}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(issueIncludes))
      errors.push(`${entry.key} invalid fixture ${label} returned unexpected issue: ${message}`);
  }
}

const sourceIds = new Set(sourceManifest.sources.map((source) => source.id));
if (sourceManifest.registryVersion !== `${IMAGE_REGISTRY_VERSION}+${VIDEO_REGISTRY_VERSION}`)
  errors.push('official source manifest registry version is stale');
if (sourceCorpusSha256(sourceManifest.sources) !== sourceManifest.corpusSha256)
  errors.push('official source corpus hash does not match committed source records');
if (sourceManifest.sources.length !== 158)
  errors.push(`expected 158 official source records, found ${sourceManifest.sources.length}`);
const modelMarkdown = sourceManifest.sources.filter(
  (source) => source.category === 'model' && source.representation === 'markdown'
);
const modelJson = sourceManifest.sources.filter(
  (source) => source.category === 'model' && source.representation === 'json'
);
if (modelMarkdown.length !== 64 || modelJson.length !== 64)
  errors.push(
    `expected 64 Markdown and 64 JSON model sources, found ${modelMarkdown.length}/${modelJson.length}`
  );
for (const source of sourceManifest.sources) {
  if (source.sha256.length !== 64 || source.canonicalSha256.length !== 64)
    errors.push(`invalid fetched body hash for ${source.id}`);
  if (source.byteLength <= 0) errors.push(`empty fetched source evidence for ${source.id}`);
  if (source.category === 'model' && source.status !== 'available')
    errors.push(`model source is not available: ${source.id} (${source.status})`);
  if (source.category === 'model' && source.representation === 'json' && !source.structured)
    errors.push(`model JSON has no reviewed structured extraction: ${source.id}`);
}

const keys = new Set<string>();
const fixtureByKey = new Map(fixtures.map((fixture) => [fixture.entryKey, fixture]));
for (const entry of entries) {
  if (keys.has(entry.key)) errors.push(`duplicate cross-modality key ${entry.key}`);
  keys.add(entry.key);
  const fixture = fixtureByKey.get(entry.key);
  if (!fixture) {
    errors.push(`missing reviewed workflow fixture ${entry.key}`);
    continue;
  }
  if (stable(fixture.schema) !== stable(liveSchema(entry)))
    errors.push(`reviewed field/role/output/condition schema drift ${entry.key}`);
  if (fixture.status !== entry.status) errors.push(`reviewed status drift ${entry.key}`);
  if (fixture.source.pageSlug !== entry.provenance.pageSlug)
    errors.push(`reviewed page provenance drift ${entry.key}`);
  if (!sourceIds.has(fixture.source.markdownId) || !sourceIds.has(fixture.source.jsonId))
    errors.push(`reviewed source record missing for ${entry.key}`);
  const markdown = sourceManifest.sources.find((source) => source.id === fixture.source.markdownId);
  const json = sourceManifest.sources.find((source) => source.id === fixture.source.jsonId);
  if (
    entry.provenance.markdownSha256 !== markdown?.sha256 ||
    entry.provenance.jsonSha256 !== json?.sha256 ||
    entry.provenance.jsonStatus !== json?.status
  )
    errors.push(`registry provenance does not match fetched bodies for ${entry.key}`);
  if (entry.status !== 'current') {
    if (fixture.vectors !== null) errors.push(`excluded fixture has request vectors ${entry.key}`);
    continue;
  }
  if (!fixture.vectors) {
    errors.push(`missing reviewed vectors ${entry.key}`);
    continue;
  }
  for (const [kind, vector] of [
    ['minimum', fixture.vectors.minimum],
    ['advanced', fixture.vectors.advanced]
  ] as const) {
    try {
      const preview = normalize(entry, vector.values);
      if (stable(preview.request) !== stable(vector.request))
        errors.push(`${entry.key} ${kind} normalized payload drift`);
      if (preview.request.model !== entry.publicModelId)
        errors.push(`${entry.key} ${kind} model adapter mismatch`);
    } catch (error) {
      errors.push(
        `${entry.key} ${kind}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (!fixture.vectors.advanced.coveredFields.length)
    errors.push(`advanced fixture covers no fields for ${entry.key}`);
  expectRejection(
    entry,
    fixture.vectors.invalid.values,
    fixture.vectors.invalid.issueIncludes,
    fixture.vectors.invalid.label
  );
}
if (fixtures.length !== entries.length)
  errors.push(
    `reviewed workflow fixture count ${fixtures.length} does not match ${entries.length}`
  );

const registryRules = new Set(entries.flatMap((entry) => entry.validation.conditionalRules));
const reviewedRules = new Set(conditionalFixtures.map((fixture) => fixture.rule));
for (const rule of registryRules)
  if (!reviewedRules.has(rule)) errors.push(`conditional rule lacks invalid fixture: ${rule}`);
for (const fixture of conditionalFixtures) {
  const entry = entries.find((candidate) => candidate.key === fixture.entryKey);
  if (!entry) {
    errors.push(`conditional fixture references missing workflow ${fixture.entryKey}`);
    continue;
  }
  if (!entry.validation.conditionalRules.includes(fixture.rule))
    errors.push(`conditional fixture ${fixture.entryKey} does not declare ${fixture.rule}`);
  expectRejection(entry, fixture.values, fixture.issueIncludes, fixture.rule);
}

for (const conflict of conflictsJson.conflicts)
  for (const sourceId of conflict.sources)
    if (!sourceIds.has(sourceId)) errors.push(`conflict ${conflict.scope} references ${sourceId}`);

if (
  IMAGE_PAGE_SLUGS.length !== 24 ||
  IMAGE_PUBLIC_IDS.length !== 47 ||
  IMAGE_REGISTRY.entries.length !== 56
)
  errors.push('image registry inventory changed without reviewed evidence');
if (
  VIDEO_PAGE_SLUGS.length !== 40 ||
  VIDEO_PUBLIC_IDS.length !== 66 ||
  VIDEO_CURRENT_ENTRIES.length !== 138
)
  errors.push('video registry inventory changed without reviewed evidence');
if (
  VIDEO_EXCLUDED_ENTRIES.length !== 2 ||
  VIDEO_EXCLUDED_ENTRIES.some((entry) => entry.workflow !== 'avatar-video')
)
  errors.push('Kling Avatar 2.0 exclusion records are incomplete');
if (VIDEO_AUDIT_RECORDS.length !== 8)
  errors.push(`expected 8 video legacy/unindexed records, found ${VIDEO_AUDIT_RECORDS.length}`);
if (
  IMAGE_REGISTRY.sourceCorpusHash !== sourceManifest.corpusSha256 ||
  VIDEO_REGISTRY.sourceCorpusHash !== sourceManifest.corpusSha256
)
  errors.push('registry manifests do not reference the official source corpus hash');
if (IMAGE_REGISTRY.manifestHash.length !== 64 || VIDEO_REGISTRY.manifestHash.length !== 64)
  errors.push('registry manifest hashes are invalid');

if (errors.length) {
  for (const error of errors) console.error(error);
  process.exit(1);
}
console.log(
  `Registry evidence valid: sources=${sourceManifest.sources.length} (${modelMarkdown.length} model Markdown/${modelJson.length} model JSON); fixtures=${fixtures.length} workflows (${IMAGE_REGISTRY.entries.length} image/${VIDEO_CURRENT_ENTRIES.length} current video/${VIDEO_EXCLUDED_ENTRIES.length} excluded); conditional=${conditionalFixtures.length}; conflicts=${conflictsJson.conflicts.length}; corpus=${sourceManifest.corpusSha256}.`
);
