export type RegistrySourceStatus = 'available' | 'unavailable' | 'contradictory' | 'unstructured';

export type RegistrySourceCategory =
  | 'index'
  | 'model'
  | 'catalog'
  | 'operations'
  | 'pricing'
  | 'audit-only';

export interface RegistrySourceSpec {
  id: string;
  category: RegistrySourceCategory;
  representation: 'text' | 'markdown' | 'json' | 'html';
  url: string;
  modality?: 'image' | 'video';
  pageSlug?: string;
  reviewStatus?: Extract<RegistrySourceStatus, 'contradictory' | 'unstructured'>;
  reviewNote?: string;
}

export interface StructuredProperty {
  path: string;
  type: string | null;
  required: boolean;
  enum?: unknown[];
  default?: unknown;
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

export interface StructuredOpenApi {
  openapi: string;
  paths: string[];
  properties: StructuredProperty[];
}

export interface RegistrySourceEvidence extends RegistrySourceSpec {
  status: RegistrySourceStatus;
  httpStatus: number;
  byteLength: number;
  sha256: string;
  canonicalSha256: string;
  canonicalization: 'raw-body-v1' | 'pricing-visible-text-v1';
  structured: StructuredOpenApi | null;
}

export interface RegistrySourceManifest {
  version: 1;
  registryVersion: string;
  verifiedAt: string;
  hashAlgorithm: 'sha256';
  corpusSha256: string;
  sources: RegistrySourceEvidence[];
}

export function sourceCorpusSha256(sources: readonly RegistrySourceEvidence[]): string {
  return new Bun.CryptoHasher('sha256')
    .update(
      JSON.stringify(
        sources.map((source) => ({
          id: source.id,
          status: source.status,
          httpStatus: source.httpStatus,
          canonicalSha256: source.canonicalSha256,
          structured: source.structured
        }))
      )
    )
    .digest('hex');
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function sha256(body: string): string {
  return new Bun.CryptoHasher('sha256').update(body).digest('hex');
}

function decodeHtml(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&nbsp;', ' ');
}

export function canonicalizePricingHtml(body: string): string {
  const main = body.match(/<main(?:\s[^>]*)?>([\s\S]*?)<\/main>/i)?.[1] ?? body;
  return decodeHtml(
    main
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveSchema(root: JsonObject, schema: unknown): JsonObject | null {
  const current = object(schema);
  const reference = typeof current?.$ref === 'string' ? current.$ref : null;
  if (!reference?.startsWith('#/')) return current;
  let resolved: unknown = root;
  for (const segment of reference.slice(2).split('/'))
    resolved = object(resolved)?.[segment.replaceAll('~1', '/').replaceAll('~0', '~')];
  return object(resolved);
}

function schemaType(schema: JsonObject): string | null {
  if (typeof schema.type === 'string') return schema.type;
  const variants = [
    ...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
    ...(Array.isArray(schema.anyOf) ? schema.anyOf : [])
  ]
    .map((item) => object(item)?.type)
    .filter((value): value is string => typeof value === 'string');
  return variants.length ? [...new Set(variants)].sort().join('|') : null;
}

function propertySummary(
  root: JsonObject,
  schemaValue: unknown,
  prefix: string,
  required: ReadonlySet<string>,
  output: StructuredProperty[],
  depth = 0
): void {
  if (depth > 5) return;
  const schema = resolveSchema(root, schemaValue);
  if (!schema) return;
  const properties = object(schema.properties);
  if (!properties) return;
  for (const key of Object.keys(properties).sort()) {
    const value = resolveSchema(root, properties[key]);
    if (!value) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const item: StructuredProperty = {
      path,
      type: schemaType(value),
      required: required.has(key)
    };
    if (Array.isArray(value.enum)) item.enum = value.enum;
    if ('default' in value) item.default = value.default;
    for (const name of [
      'format',
      'minimum',
      'maximum',
      'minLength',
      'maxLength',
      'minItems',
      'maxItems'
    ] as const) {
      const candidate = value[name];
      if (name === 'format') {
        if (typeof candidate === 'string') item.format = candidate;
      } else if (typeof candidate === 'number') item[name] = candidate;
    }
    output.push(item);
    const childRequired = new Set(
      Array.isArray(value.required)
        ? value.required.filter((candidate): candidate is string => typeof candidate === 'string')
        : []
    );
    propertySummary(root, value, path, childRequired, output, depth + 1);
  }
}

export function extractStructuredOpenApi(body: string): StructuredOpenApi | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const root = object(parsed);
  if (!root || typeof root.openapi !== 'string') return null;
  const output: StructuredProperty[] = [];
  const schemas = object(object(root.components)?.schemas);
  if (schemas) {
    for (const name of Object.keys(schemas).sort()) {
      const schema = resolveSchema(root, schemas[name]);
      if (!schema) continue;
      const required = new Set(
        Array.isArray(schema.required)
          ? schema.required.filter(
              (candidate): candidate is string => typeof candidate === 'string'
            )
          : []
      );
      propertySummary(root, schema, name, required, output);
    }
  }
  return {
    openapi: root.openapi,
    paths: Object.keys(object(root.paths) ?? {}).sort(),
    properties: output.sort((left, right) => left.path.localeCompare(right.path))
  };
}

export async function fetchRegistrySource(
  spec: RegistrySourceSpec,
  captureBody?: (body: string) => void
): Promise<RegistrySourceEvidence> {
  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(spec.url, {
        headers: {
          accept: spec.representation === 'json' ? 'application/json' : 'text/plain,*/*'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000)
      });
    } catch (error) {
      if (attempt === 2)
        throw new Error(`Unable to fetch registry source ${spec.id} (${spec.url}).`, {
          cause: error
        });
    }
    if (response && response.status !== 429 && response.status < 500) break;
    if (attempt < 2) await Bun.sleep(250 * 2 ** attempt);
  }
  if (!response) throw new Error(`Unable to fetch registry source ${spec.id} (${spec.url}).`);
  const body = await response.text();
  captureBody?.(body);
  const canonicalBody = spec.representation === 'html' ? canonicalizePricingHtml(body) : body;
  const status: RegistrySourceStatus =
    response.status < 200 || response.status >= 300
      ? 'unavailable'
      : (spec.reviewStatus ?? 'available');
  return {
    ...spec,
    status,
    httpStatus: response.status,
    byteLength: new TextEncoder().encode(body).byteLength,
    sha256: sha256(body),
    canonicalSha256: sha256(canonicalBody),
    canonicalization: spec.representation === 'html' ? 'pricing-visible-text-v1' : 'raw-body-v1',
    structured:
      response.ok && spec.representation === 'json' ? extractStructuredOpenApi(body) : null
  };
}

export function structuredDiff(
  baseline: StructuredOpenApi | null,
  current: StructuredOpenApi | null
): string[] {
  if (!baseline && !current) return [];
  if (!baseline || !current) return ['structured OpenAPI availability changed'];
  const changes: string[] = [];
  if (baseline.openapi !== current.openapi)
    changes.push(`OpenAPI version ${baseline.openapi} -> ${current.openapi}`);
  const baselinePaths = new Set(baseline.paths);
  const currentPaths = new Set(current.paths);
  for (const path of current.paths)
    if (!baselinePaths.has(path)) changes.push(`added path ${path}`);
  for (const path of baseline.paths)
    if (!currentPaths.has(path)) changes.push(`removed path ${path}`);
  const baselineProperties = new Map(baseline.properties.map((item) => [item.path, item]));
  const currentProperties = new Map(current.properties.map((item) => [item.path, item]));
  for (const [path, property] of currentProperties) {
    const previous = baselineProperties.get(path);
    if (!previous) changes.push(`added property ${path}`);
    else if (JSON.stringify(previous) !== JSON.stringify(property))
      changes.push(`changed property ${path}`);
  }
  for (const path of baselineProperties.keys())
    if (!currentProperties.has(path)) changes.push(`removed property ${path}`);
  return changes;
}
