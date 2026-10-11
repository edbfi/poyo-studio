import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  IMAGE_REGISTRY_ENTRIES,
  IMAGE_REGISTRY_VERSION
} from '../src/lib/features/registry/image-registry';
import { minimumValidRequest, normalizeImageRequest } from '../src/lib/features/registry/normalize';
import {
  minimumValidVideoRequest,
  normalizeVideoRequest
} from '../src/lib/features/registry/normalize-video';
import type {
  FieldDefinition,
  GuidedImageRequest,
  GuidedVideoRequest,
  ImageRegistryEntry,
  NormalizedPreview,
  VideoRegistryEntry
} from '../src/lib/features/registry/types';
import {
  VIDEO_REGISTRY_ENTRIES,
  VIDEO_REGISTRY_VERSION
} from '../src/lib/features/registry/video-registry';

type RegistryEntry = ImageRegistryEntry | VideoRegistryEntry;
type GuidedValues = GuidedImageRequest | GuidedVideoRequest;

interface InvalidVector {
  label: string;
  values: Record<string, unknown>;
  issueIncludes: string;
}

interface WorkflowFixture {
  entryKey: string;
  status: RegistryEntry['status'];
  source: { pageSlug: string; markdownId: string; jsonId: string };
  schema: {
    publicModelId: string;
    workflow: string;
    fields: RegistryEntry['fields'];
    inputRoles: RegistryEntry['inputRoles'];
    output: RegistryEntry['output'];
    validation: RegistryEntry['validation'];
    payload: RegistryEntry['payload'];
    limitations: RegistryEntry['limitations'];
  };
  vectors: null | {
    minimum: { values: Record<string, unknown>; request: NormalizedPreview['request'] };
    advanced: {
      values: Record<string, unknown>;
      request: NormalizedPreview['request'];
      coveredFields: string[];
    };
    invalid: InvalidVector;
  };
  manualDecisions: string[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalize(entry: RegistryEntry, values: GuidedValues): NormalizedPreview {
  return entry.output.mediaKind === 'image'
    ? normalizeImageRequest(entry.key, values as GuidedImageRequest)
    : normalizeVideoRequest(entry.key, values as GuidedVideoRequest);
}

function minimum(entry: RegistryEntry): GuidedValues {
  return entry.output.mediaKind === 'image'
    ? minimumValidRequest(entry)
    : minimumValidVideoRequest(entry);
}

function advancedPatch(field: FieldDefinition): Record<string, unknown> | null {
  if (field.key === 'prompt' || field.key === 'multiPrompt' || field.key === 'elements')
    return null;
  if (field.kind === 'dimensions') return { width: 1024, height: 1024 };
  if (field.enum?.length) {
    const value = field.enum.at(-1);
    if (value === undefined) return null;
    return { [field.key]: /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value };
  }
  if (field.kind === 'boolean') return { [field.key]: field.default !== true };
  if (field.kind === 'integer' || field.kind === 'number')
    return { [field.key]: field.max ?? field.min ?? 1 };
  if (field.kind === 'text') return { [field.key]: 'reviewed advanced value' };
  if (field.kind === 'string-list') return { [field.key]: ['https://assets.example/reviewed.png'] };
  return null;
}

function advanced(
  entry: RegistryEntry,
  base: GuidedValues
): {
  values: GuidedValues;
  preview: NormalizedPreview;
  coveredFields: string[];
} {
  let values = clone(base) as Record<string, unknown>;
  const coveredFields: string[] = [];
  for (const field of entry.fields) {
    if (field.level === 'essential') continue;
    const patch = advancedPatch(field);
    if (!patch) continue;
    const candidate = { ...values, ...patch };
    try {
      normalize(entry, candidate as GuidedValues);
      values = candidate;
      coveredFields.push(field.key);
    } catch {
      // Conditional combinations remain represented by the committed invalid-vector corpus.
    }
  }
  return { values: values as GuidedValues, preview: normalize(entry, values), coveredFields };
}

function invalid(entry: RegistryEntry, base: GuidedValues): InvalidVector {
  const baseValues = clone(base) as Record<string, unknown>;
  const requiredField = entry.fields.find((field) => field.required && field.default === undefined);
  if (requiredField) {
    delete baseValues[requiredField.key];
    return {
      label: `required ${requiredField.key}`,
      values: baseValues,
      issueIncludes: `${requiredField.key} is required`
    };
  }
  const requiredRole = entry.inputRoles.find((role) => role.required);
  if (requiredRole) {
    const key =
      requiredRole.requestKey ??
      (entry.output.mediaKind === 'image' && requiredRole.role === 'reference'
        ? 'imageUrls'
        : null);
    if (key) delete baseValues[key];
    return {
      label: `required ${requiredRole.role} input`,
      values: baseValues,
      issueIncludes: requiredRole.role
    };
  }
  const enumField = entry.fields.find((field) => field.enum?.length);
  if (enumField) {
    baseValues[enumField.key] = '__unsupported_fixture_value__';
    return {
      label: `unsupported ${enumField.key}`,
      values: baseValues,
      issueIncludes: `${enumField.key} is unsupported`
    };
  }
  const booleanField = entry.fields.find((field) => field.kind === 'boolean');
  if (booleanField) {
    baseValues[booleanField.key] = 'invalid';
    return {
      label: `invalid ${booleanField.key} type`,
      values: baseValues,
      issueIncludes: `${booleanField.key} must be boolean`
    };
  }
  throw new Error(`No invalid fixture candidate for ${entry.key}.`);
}

function fixture(entry: RegistryEntry): WorkflowFixture {
  const source = {
    pageSlug: entry.provenance.pageSlug,
    markdownId: `model:${entry.output.mediaKind}:${entry.provenance.pageSlug}:markdown`,
    jsonId: `model:${entry.output.mediaKind}:${entry.provenance.pageSlug}:json`
  };
  const schema = {
    publicModelId: entry.publicModelId,
    workflow: entry.workflow,
    fields: entry.fields,
    inputRoles: entry.inputRoles,
    output: entry.output,
    validation: entry.validation,
    payload: entry.payload,
    limitations: entry.limitations
  };
  const manualDecisions = [
    ...entry.validation.conditionalRules.map((rule) => `Reviewed adapter condition: ${rule}.`),
    entry.output.safetyChecker
      ? 'Project override: enable_safety_checker is explicitly false unless the user opts in.'
      : 'Project override: enable_safety_checker is sent as false even though this page does not document it, following the existing studio policy.',
    ...entry.limitations
  ];
  if (entry.status !== 'current')
    return {
      entryKey: entry.key,
      status: entry.status,
      source,
      schema,
      vectors: null,
      manualDecisions
    };
  const minimumValues = minimum(entry);
  const minimumPreview = normalize(entry, minimumValues);
  const advancedVector = advanced(entry, minimumValues);
  return {
    entryKey: entry.key,
    status: entry.status,
    source,
    schema,
    vectors: {
      minimum: { values: clone(minimumValues), request: minimumPreview.request },
      advanced: {
        values: clone(advancedVector.values),
        request: advancedVector.preview.request,
        coveredFields: advancedVector.coveredFields
      },
      invalid: invalid(entry, minimumValues)
    },
    manualDecisions
  };
}

async function write(name: string, registryVersion: string, entries: readonly RegistryEntry[]) {
  const outputPath = resolve(`src/lib/features/registry/evidence/${name}`);
  const payload = {
    version: 1,
    registryVersion,
    reviewedAt: entries[0]?.provenance.verifiedAt,
    workflows: entries.map(fixture)
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote ${payload.workflows.length} reviewed workflows to ${outputPath}.`);
}

await write('reviewed-image-fixtures.json', IMAGE_REGISTRY_VERSION, IMAGE_REGISTRY_ENTRIES);
await write(
  'reviewed-video-fixtures-a-m.json',
  VIDEO_REGISTRY_VERSION,
  VIDEO_REGISTRY_ENTRIES.filter((entry) => entry.provenance.pageSlug.localeCompare('n') < 0)
);
await write(
  'reviewed-video-fixtures-n-z.json',
  VIDEO_REGISTRY_VERSION,
  VIDEO_REGISTRY_ENTRIES.filter((entry) => entry.provenance.pageSlug.localeCompare('n') >= 0)
);
