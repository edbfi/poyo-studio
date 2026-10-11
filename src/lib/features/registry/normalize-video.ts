import { RegistryValidationError } from './normalize';
import {
  fieldValue,
  isExpertOverride,
  isStrictJsonValue,
  validateFieldValue
} from './runtime-validation';
import type {
  ExpertOverride,
  FieldDefinition,
  GuidedVideoRequest,
  InputRole,
  NormalizedPreview,
  VideoRegistryEntry
} from './types';
import { seedanceReferenceLimits, VIDEO_REGISTRY_ENTRIES } from './video-registry';

const protectedKeys =
  /(?:model|callback|api.?key|authorization|cookie|credential|password|secret|token|path|file|directory)/i;
const mediaRequestKeys: Array<keyof GuidedVideoRequest> = [
  'imageUrls',
  'startImageUrl',
  'endImageUrl',
  'referenceImageUrls',
  'videoUrls',
  'videoUrl',
  'referenceVideoUrls',
  'referenceAudioUrls',
  'audioUrl',
  'elementImageUrls'
];

function entryFor(key: string): VideoRegistryEntry {
  const entry = VIDEO_REGISTRY_ENTRIES.find((item) => item.key === key);
  if (entry?.status !== 'current')
    throw new RegistryValidationError(['Unknown or non-selectable video registry workflow.']);
  return entry;
}

function valuesForRole(values: GuidedVideoRequest, role: InputRole): string[] {
  if (!role.requestKey) return [];
  const value: unknown = values[role.requestKey];
  if (typeof value === 'string') return value ? [value] : [];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function validateRoleValue(values: GuidedVideoRequest, role: InputRole): string[] {
  if (!role.requestKey) return [];
  const value: unknown = values[role.requestKey];
  if (value === undefined) return [];
  if (role.apiKey?.endsWith('_url'))
    return typeof value === 'string' ? [] : [`${role.requestKey} must be a string.`];
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? []
    : [`${role.requestKey} must be a list of strings.`];
}

function validateUrls(urls: readonly string[], label: string): string[] {
  const issues: string[] = [];
  for (const value of urls) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      issues.push(`${label} URL is invalid.`);
      continue;
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      issues.push(`${label} requires HTTP(S) URLs without credentials.`);
  }
  return issues;
}

function validate(entry: VideoRegistryEntry, values: GuidedVideoRequest): string[] {
  const issues: string[] = [];
  const acceptedFields = new Set(entry.fields.map((field) => field.key));
  for (const field of entry.fields) {
    const value = fieldValue(values as Record<string, unknown>, field);
    issues.push(...validateFieldValue(field, value));
  }
  const acceptedMedia = new Set<string>(
    entry.inputRoles.flatMap((role) => (role.requestKey ? [role.requestKey] : []))
  );
  for (const key of mediaRequestKeys) {
    const value = values[key];
    if (value !== undefined && !acceptedMedia.has(key))
      issues.push(`${key} is not supported for this workflow.`);
  }
  for (const role of entry.inputRoles) {
    issues.push(...validateRoleValue(values, role));
    const roleValues = valuesForRole(values, role);
    if (role.required && roleValues.length < role.min)
      issues.push(`${role.role} requires at least ${role.min} input.`);
    if (role.max !== null && roleValues.length > role.max)
      issues.push(`${role.role} supports at most ${role.max} inputs.`);
    issues.push(...validateUrls(roleValues, role.role));
  }
  for (const key of Object.keys(values))
    if (!acceptedFields.has(key) && !acceptedMedia.has(key))
      issues.push(`${key} is not supported for this workflow.`);

  if (
    entry.family === 'Hailuo 02' &&
    entry.workflow === 'frame-to-video' &&
    values.resolution !== '768P'
  )
    issues.push('Hailuo 02 end frame requires 768P.');
  if (
    entry.family === 'Hailuo 2.3' &&
    values.resolution === '1080p' &&
    (values.duration ?? 6) !== 6
  )
    issues.push('Hailuo 2.3 1080p supports 6 seconds only.');
  if (entry.family === 'Hailuo 03' && entry.workflow === 'reference-to-video') {
    const images = values.referenceImageUrls?.length ?? 0;
    const videos = values.referenceVideoUrls?.length ?? 0;
    if (!images && !videos)
      issues.push('Hailuo 03 reference mode requires a reference image or video.');
  }
  if (
    entry.family === 'H3 Max' &&
    entry.workflow === 'reference-to-video' &&
    (values.referenceImageUrls?.length ?? 0) +
      (values.referenceVideoUrls?.length ?? 0) +
      (values.referenceAudioUrls?.length ?? 0) >
      12
  )
    issues.push('H3 Max supports at most 12 total reference files.');
  if (
    entry.family === 'Sora 2 Pro Official' &&
    entry.workflow === 'text-to-video' &&
    values.aspectRatio === 'auto'
  )
    issues.push('Sora 2 Pro aspect_ratio=auto requires an image.');

  if (entry.workflow === 'multi-shot-video') {
    const shots = values.multiPrompt ?? [];
    const shotMax = entry.family.startsWith('Kling O3') ? 12 : 15;
    for (const shot of shots)
      if (
        !shot ||
        typeof shot.prompt !== 'string' ||
        !shot.prompt.trim() ||
        !Number.isInteger(shot.duration) ||
        shot.duration < 1 ||
        shot.duration > shotMax
      )
        issues.push(`Each multi_prompt shot requires prompt and duration 1-${shotMax}.`);
    const total = shots.reduce((sum, shot) => {
      if (!shot || typeof shot !== 'object' || !Number.isFinite(shot.duration)) return sum;
      return sum + shot.duration;
    }, 0);
    if (total < 3 || total > 15) issues.push('Multi-shot total duration must be 3-15 seconds.');
    if (values.duration !== undefined && total !== values.duration)
      issues.push('Multi-shot duration must equal the total shot duration.');
    if (entry.fields.some((field) => field.key === 'sound') && values.sound === false)
      issues.push('Kling multi-shot requires sound=true.');
  }

  if (entry.workflow === 'keyframe-to-video') {
    // Keyframes are positioned on a documented 24 fps timeline, so every index must be a unique
    // whole frame inside the requested duration.
    const framesPerSecond = 24;
    const maxIndex = (values.duration ?? 0) * framesPerSecond;
    const seen = new Set<number>();
    for (const keyframe of values.keyframes ?? []) {
      if (!keyframe || typeof keyframe.image_url !== 'string' || !keyframe.image_url.trim()) {
        issues.push('Each keyframe requires an image_url.');
        continue;
      }
      issues.push(...validateUrls([keyframe.image_url], 'keyframe'));
      if (
        !Number.isInteger(keyframe.frame_index) ||
        keyframe.frame_index < 0 ||
        keyframe.frame_index > maxIndex
      )
        issues.push(`Each keyframe requires frame_index 0-${maxIndex}.`);
      else if (seen.has(keyframe.frame_index))
        issues.push('Keyframe frame_index values must be unique.');
      else seen.add(keyframe.frame_index);
    }
  }

  if (entry.workflow === 'motion-control') {
    const orientation = values.characterOrientation ?? 'image';
    const observedDuration = values.referenceVideoDuration;
    if (observedDuration !== undefined && orientation === 'image' && observedDuration > 10)
      issues.push('Image orientation supports reference videos through 10 seconds only.');
    if (
      entry.family === 'Kling 3.0 Motion Control' &&
      values.elements?.length &&
      orientation !== 'video'
    )
      issues.push('Facial elements require video orientation.');
  }

  if (entry.family.startsWith('Seedance 2') && entry.workflow === 'reference-to-video') {
    const images = values.referenceImageUrls?.length ?? 0;
    const videos = values.referenceVideoUrls?.length ?? 0;
    const audios = values.referenceAudioUrls?.length ?? 0;
    if (!images && !videos && !audios)
      issues.push('Seedance reference mode requires reference media.');
    const total = seedanceReferenceLimits(entry.family).total;
    if (images + videos + audios > total)
      issues.push(`Seedance supports at most ${total} total reference files.`);
    if (audios && !images && !videos)
      issues.push('Seedance reference audio requires an image or video reference.');
  }

  if (entry.family === 'Wan 2.7 Video') {
    if (
      entry.workflow === 'reference-to-video' &&
      !(values.referenceImageUrls?.length || values.referenceVideoUrls?.length)
    )
      issues.push('Wan 2.7 reference mode requires reference image or video input.');
    if (
      entry.workflow === 'video-edit' &&
      values.duration !== undefined &&
      values.duration !== 0 &&
      values.duration < 2
    )
      issues.push('Wan 2.7 edit duration must be 0 or 2-10 seconds.');
  }

  // The page also documents a reference document and a reference webpage, neither of which is
  // media a studio input role can supply, so a reference request that arrives without any of the
  // three exposed media lists carries nothing to work from.
  if (
    entry.family.startsWith('Wan 3.0') &&
    entry.workflow === 'reference-to-video' &&
    !(
      values.referenceImageUrls?.length ||
      values.referenceVideoUrls?.length ||
      values.referenceAudioUrls?.length
    )
  )
    issues.push('Wan 3.0 reference mode requires reference media.');

  if (entry.family === 'VEO 3.1 Official') {
    const count = values.imageUrls?.length ?? 0;
    const duration = values.duration;
    if (entry.workflow === 'reference-to-video' && duration !== 8)
      issues.push('Official VEO reference generation requires 8 seconds.');
    if (
      entry.workflow === 'frame-to-video' &&
      entry.publicModelId.includes('lite') &&
      count === 2 &&
      duration !== 8
    )
      issues.push('Official VEO Lite frame generation requires 8 seconds.');
    if (entry.publicModelId.includes('lite') && values.resolution === '1080p' && duration !== 8)
      issues.push('Official VEO Lite 1080p requires 8 seconds.');
    if (
      values.aspectRatio === 'auto' &&
      entry.workflow !== 'image-to-video' &&
      entry.workflow !== 'frame-to-video'
    )
      issues.push('Official VEO aspect_ratio=auto requires image or frame generation.');
  }
  return issues;
}

export function normalizeVideoRequest(
  entryKey: string,
  values: GuidedVideoRequest,
  overrides: readonly ExpertOverride[] = []
): NormalizedPreview {
  const entry = entryFor(entryKey);
  if (!values || typeof values !== 'object' || Array.isArray(values))
    throw new RegistryValidationError(['Guided values must be an object.']);
  if (!Array.isArray(overrides) || !overrides.every(isExpertOverride))
    throw new RegistryValidationError(['Expert overrides must contain key/value objects.']);
  const issues = validate(entry, values);
  if (issues.length) throw new RegistryValidationError(issues);
  const input: Record<string, unknown> = { ...(entry.payload.fixedInput ?? {}) };
  const runtimeValues = values as Record<string, unknown>;
  for (const field of entry.fields) {
    const value = fieldValue(runtimeValues, field);
    if (value === undefined || field.apiKey.startsWith('__local_')) continue;
    input[field.apiKey] = value;
  }
  for (const role of entry.inputRoles) {
    if (!role.apiKey) continue;
    const roleValues = valuesForRole(values, role);
    if (!roleValues.length) continue;
    input[role.apiKey] = role.apiKey.endsWith('_url') ? roleValues[0] : roleValues;
  }
  // Poyo drops enable_safety_checker on models whose page does not document it, verified live
  // across every provider family, so the studio always opts out of provider-side filtering.
  input.enable_safety_checker = values.enableSafetyChecker ?? false;

  const verifiedKeys = new Set(
    entry.fields
      .map((field) => field.apiKey)
      .concat(entry.inputRoles.flatMap((role) => (role.apiKey ? [role.apiKey] : [])))
      .concat(Object.keys(entry.payload.fixedInput ?? {}))
  );
  const expertDiff: NormalizedPreview['expertDiff'] = [];
  for (const override of overrides) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(override.key) || protectedKeys.test(override.key))
      throw new RegistryValidationError([`Expert override ${override.key} is protected.`]);
    if (verifiedKeys.has(override.key))
      throw new RegistryValidationError([
        `Use the guided field for verified parameter ${override.key}.`
      ]);
    if (entry.publicModelId === 'wan2.7-image-to-video' && override.key === 'aspect_ratio')
      throw new RegistryValidationError([
        'Expert override aspect_ratio is not supported for Wan 2.7 image-to-video.'
      ]);
    if (
      ['hailuo-03', 'h3-max', 'h3-max-turbo', 'grok-imagine-video-1.5'].includes(
        entry.publicModelId
      ) &&
      entry.workflow === 'image-to-video' &&
      override.key === 'aspect_ratio'
    )
      throw new RegistryValidationError([
        `Expert override aspect_ratio is not supported for ${entry.family} image-to-video.`
      ]);
    if (!isStrictJsonValue(override.value))
      throw new RegistryValidationError([`Expert override ${override.key} must be strict JSON.`]);
    input[override.key] = override.value;
    expertDiff.push({ key: override.key, status: 'unverified', value: override.value });
  }
  return {
    request: { model: entry.publicModelId, input },
    guidedInput: input,
    expertDiff,
    warnings: expertDiff.map((item) => `${item.key} is an unverified expert override.`)
  };
}

function minimumFieldValue(entry: VideoRegistryEntry, field: FieldDefinition): unknown {
  if (field.default !== undefined) return field.default;
  if (field.key === 'prompt') return 'studio video';
  if (field.key === 'multiPrompt') {
    const durationField = entry.fields.find((candidate) => candidate.key === 'duration');
    const duration = Number(durationField?.default ?? durationField?.min ?? 3);
    return [{ prompt: 'establishing shot', duration }];
  }
  if (field.key === 'keyframes')
    return [{ image_url: 'https://assets.example/keyframe.png', frame_index: 0 }];
  if (field.key === 'elements' && field.required)
    return [{ name: 'subject', element_input_urls: ['https://assets.example/element.png'] }];
  if (field.key === 'elements') return undefined;
  if (field.enum?.length) {
    const first = field.enum[0];
    if (first !== undefined)
      return field.kind === 'enum' && /^\d+$/.test(first) ? Number(first) : first;
  }
  if (field.kind === 'integer') return field.min ?? 1;
  if (field.kind === 'boolean') return false;
  return undefined;
}

export function minimumValidVideoRequest(entry: VideoRegistryEntry): GuidedVideoRequest {
  if (entry.status !== 'current') return {};
  const values: GuidedVideoRequest = {};
  for (const field of entry.fields) {
    const value = minimumFieldValue(entry, field);
    if (value !== undefined) (values as Record<string, unknown>)[field.key] = value;
  }
  for (const role of entry.inputRoles) {
    if (!role.required || !role.requestKey) continue;
    const urls = Array.from({ length: role.min }, (_, index) => {
      const extension =
        role.mediaKind === 'image' ? 'png' : role.mediaKind === 'video' ? 'mp4' : 'mp3';
      return `https://assets.example/${role.role}-${index}.${extension}`;
    });
    (values as Record<string, unknown>)[role.requestKey] =
      typeof values[role.requestKey] === 'string' || role.apiKey?.endsWith('_url') ? urls[0] : urls;
  }
  if (entry.workflow === 'reference-to-video' && entry.family.startsWith('Seedance 2'))
    values.referenceImageUrls = ['https://assets.example/reference.png'];
  if (entry.workflow === 'reference-to-video' && entry.family === 'Wan 2.7 Video')
    values.referenceImageUrls = ['https://assets.example/reference.png'];
  if (entry.workflow === 'reference-to-video' && entry.family.startsWith('Wan 3.0'))
    values.referenceImageUrls = ['https://assets.example/reference.png'];
  if (entry.workflow === 'reference-to-video' && entry.family === 'Hailuo 03')
    values.referenceImageUrls = ['https://assets.example/reference.png'];
  if (entry.family === 'Hailuo 02' && entry.workflow === 'frame-to-video')
    values.resolution = '768P';
  if (
    entry.family === 'VEO 3.1 Official' &&
    (entry.workflow === 'reference-to-video' ||
      (entry.workflow === 'frame-to-video' && entry.publicModelId.includes('lite')))
  )
    values.duration = 8;
  if (
    entry.family === 'VEO 3.1 Official' &&
    entry.workflow !== 'image-to-video' &&
    entry.workflow !== 'frame-to-video'
  )
    values.aspectRatio = '16:9';
  return values;
}
