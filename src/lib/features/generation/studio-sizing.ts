import {
  resolveClosestRatioForDimensions,
  supportedRatioTokens,
  upstreamAutomaticRatioToken
} from '../registry/ratio-resolver';
import { highestResolutionToken } from '../registry/resolution-resolver';
import type { FieldDefinition } from '../registry/types';
import type { StudioEntry, StudioRoleInput } from './contracts';

export type AutomaticFieldKey = 'aspectRatio' | 'resolution';
export type AutomaticFieldState = Record<AutomaticFieldKey, boolean>;

export interface AutomaticFieldChoice {
  available: boolean;
  label: string;
  value?: unknown;
  kind:
    | 'unavailable'
    | 'upstream-auto'
    | 'source'
    | 'source-unavailable'
    | 'registry-default'
    | 'model-default';
  description?: string;
}

function fieldFor(entry: StudioEntry, key: AutomaticFieldKey): FieldDefinition | undefined {
  return entry.fields.find((field) => field.key === key);
}

function firstMeasuredImage(
  entry: StudioEntry,
  roleInputs: Record<string, StudioRoleInput[]>
): StudioRoleInput | undefined {
  for (const role of entry.inputRoles) {
    if (role.mediaKind !== 'image') continue;
    const measured = (roleInputs[role.role] ?? []).find(
      (input) =>
        input.mediaKind === 'image' &&
        input.width !== undefined &&
        input.height !== undefined &&
        Number.isFinite(input.width) &&
        Number.isFinite(input.height) &&
        input.width > 0 &&
        input.height > 0
    );
    if (measured) return measured;
  }
  return undefined;
}

/**
 * How a workflow may derive its output ratio from the media a person supplied.
 * Image edits always follow their reference; video workflows accept both image and video
 * sources, so only a lone image can decide the output ratio.
 */
type SourceRatioDerivation = 'image-edit' | 'image-driven-video';

function sourceRatioDerivation(
  entry: StudioEntry,
  roleInputs: Record<string, StudioRoleInput[]>
): SourceRatioDerivation | null {
  if (entry.output.mediaKind === 'image')
    return entry.workflow === 'text-to-image' ? null : 'image-edit';
  if (!entry.inputRoles.some((role) => role.mediaKind === 'image')) return null;
  // A workflow that requires a video is sized by that video, not by an accompanying reference.
  if (entry.inputRoles.some((role) => role.mediaKind === 'video' && role.required)) return null;
  const supplied = entry.inputRoles.flatMap((role) => roleInputs[role.role] ?? []);
  return supplied.some((input) => input.mediaKind === 'video') ? null : 'image-driven-video';
}

/**
 * Documented conditional rules that tie the largest resolution tier to another field, so their
 * models keep the reviewed default instead of starting from a combination the provider rejects.
 * VEO 3.1 couples 1080p and 4k to an eight-second duration.
 */
const RESOLUTION_COUPLED_RULES = ['generation-type-model-duration-matrix'];

/**
 * The output resolution a fresh draft starts from: the largest tier the model exposes, so a
 * documented lower default never silently caps quality. Single-tier enums keep the automatic
 * choice because there is nothing to pick.
 */
export function preselectedResolutionToken(entry: StudioEntry): string | undefined {
  const field = fieldFor(entry, 'resolution');
  const supported = field?.enum ?? [];
  if (supported.length < 2) return undefined;
  // Union-size families accept a resolution or an aspect ratio, never both, so a defaulted
  // ratio keeps ownership of the shared size field.
  if (
    entry.validation.conditionalRules.includes('size-is-one-of-resolution-ratio-or-custom') &&
    entry.fields.some(
      (candidate) => candidate.key === 'aspectRatio' && candidate.default !== undefined
    )
  )
    return undefined;
  if (entry.validation.conditionalRules.some((rule) => RESOLUTION_COUPLED_RULES.includes(rule)))
    return undefined;
  return highestResolutionToken(supported) ?? undefined;
}

export function automaticFieldChoice(
  entry: StudioEntry,
  key: AutomaticFieldKey,
  roleInputs: Record<string, StudioRoleInput[]>
): AutomaticFieldChoice {
  const field = fieldFor(entry, key);
  if (!field) return { available: false, label: 'Automatic unavailable', kind: 'unavailable' };

  const upstreamAutomatic =
    key === 'aspectRatio' ? upstreamAutomaticRatioToken(field.enum ?? []) : null;
  if (upstreamAutomatic) {
    return {
      available: true,
      label: 'Automatic (model decides)',
      value: upstreamAutomatic,
      kind: 'upstream-auto',
      description: 'The model accepts a genuine automatic value.'
    };
  }

  const derivation = key === 'aspectRatio' ? sourceRatioDerivation(entry, roleInputs) : null;
  if (derivation) {
    const source = firstMeasuredImage(entry, roleInputs);
    if (source) {
      const supported = supportedRatioTokens(field.enum ?? []);
      const resolved = resolveClosestRatioForDimensions(supported, {
        width: source.width ?? 0,
        height: source.height ?? 0
      });
      if (resolved.token) {
        return {
          available: true,
          label: `Automatic (${resolved.token} from ${source.width} × ${source.height})`,
          value: resolved.token,
          kind: 'source',
          description: 'Uses the first measurable image in the model’s documented input-role order.'
        };
      }
    }
    // An image edit cannot be sized without its reference, while a video workflow still has the
    // documented model behaviour to fall back on until an image is measured.
    if (derivation === 'image-edit')
      return {
        available: field.default !== undefined || !field.required,
        label: 'Automatic (choose a measured source or ratio)',
        kind: 'source-unavailable',
        description:
          'This model has no genuine auto value, so a source image must be measured before its closest supported ratio can be selected.'
      };
  }

  if (field.default !== undefined) {
    return {
      available: true,
      label: `Automatic (${String(field.default)})`,
      value: field.default,
      kind: 'registry-default',
      description: 'Uses the model default verified in the registry evidence.'
    };
  }

  if (entry.validation.conditionalRules.includes('size-and-resolution-required')) {
    return {
      available: false,
      label: 'Automatic unavailable',
      kind: 'unavailable',
      description: 'This model requires an explicit value alongside its other size field.'
    };
  }

  if (!field.required) {
    return {
      available: true,
      label: 'Automatic (model default)',
      kind: 'model-default',
      description: 'Omits this field and lets the model apply its documented behavior.'
    };
  }

  return {
    available: false,
    label: 'Automatic unavailable',
    kind: 'unavailable',
    description: 'This model requires an explicit value.'
  };
}

export function initialAutomaticFields(
  entry: StudioEntry,
  explicitValues = false
): AutomaticFieldState {
  return {
    aspectRatio: !explicitValues && automaticFieldChoice(entry, 'aspectRatio', {}).available,
    resolution:
      !explicitValues &&
      preselectedResolutionToken(entry) === undefined &&
      automaticFieldChoice(entry, 'resolution', {}).available
  };
}

export function restoreAutomaticFields(
  entry: StudioEntry,
  requested: readonly AutomaticFieldKey[]
): AutomaticFieldState {
  return {
    aspectRatio:
      requested.includes('aspectRatio') &&
      entry.fields.some((field) => field.key === 'aspectRatio'),
    resolution:
      requested.includes('resolution') && entry.fields.some((field) => field.key === 'resolution')
  };
}

export function resolvedGuidedValues(
  entry: StudioEntry,
  guided: Record<string, unknown>,
  roleInputs: Record<string, StudioRoleInput[]>,
  automaticFields: AutomaticFieldState
): Record<string, unknown> {
  const resolved = JSON.parse(JSON.stringify(guided)) as Record<string, unknown>;
  for (const key of ['aspectRatio', 'resolution'] as const) {
    if (!automaticFields[key]) continue;
    delete resolved[key];
    const choice = automaticFieldChoice(entry, key, roleInputs);
    if (choice.value !== undefined)
      resolved[key] = JSON.parse(JSON.stringify(choice.value)) as unknown;
  }
  return resolved;
}

export function automaticSizingIssues(
  entry: StudioEntry,
  roleInputs: Record<string, StudioRoleInput[]>,
  automaticFields: AutomaticFieldState
): string[] {
  const issues: string[] = [];
  for (const key of ['aspectRatio', 'resolution'] as const) {
    if (!automaticFields[key]) continue;
    const choice = automaticFieldChoice(entry, key, roleInputs);
    if (choice.kind === 'source-unavailable') {
      issues.push(
        'Automatic aspect ratio needs a source image whose dimensions this browser can measure. Add a measurable local image or choose an explicit ratio.'
      );
    } else if (!choice.available) {
      issues.push(
        `${key === 'aspectRatio' ? 'Aspect ratio' : 'Resolution'} requires an explicit value.`
      );
    }
  }
  return issues;
}
