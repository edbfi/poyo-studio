import { describe, expect, test } from 'bun:test';
import {
  studioMode,
  studioModeGroups,
  studioModeLabel
} from '../../../src/lib/features/generation/studio-modes';
import { IMAGE_REGISTRY_ENTRIES } from '../../../src/lib/features/registry/image-registry';
import { VIDEO_CURRENT_ENTRIES } from '../../../src/lib/features/registry/video-registry';

describe('studio creative-intent modes', () => {
  test('MODE-01 covers every selectable image and video workflow', () => {
    const workflows = [
      ...new Set(
        [...IMAGE_REGISTRY_ENTRIES, ...VIDEO_CURRENT_ENTRIES].map((entry) => entry.workflow)
      )
    ];
    expect(workflows.length).toBeGreaterThan(0);
    for (const workflow of workflows) {
      const mode = studioMode(workflow);
      expect(mode.group).not.toBe('other');
      expect(mode.label).not.toBe(workflow.replaceAll('-', ' '));
      expect(mode.tag).toMatch(/^[a-z0-9]+$/);
    }
  });

  test('MODE-02 splits video modes into create and edit with catalogue order', () => {
    const groups = studioModeGroups(VIDEO_CURRENT_ENTRIES.map((entry) => entry.workflow));
    expect(groups.map((group) => group.key)).toEqual(['create', 'edit']);
    expect(groups[0]?.modes.map((mode) => mode.workflow)).toEqual([
      'text-to-video',
      'multi-shot-video'
    ]);
    expect(groups[1]?.modes.map((mode) => mode.tag)).toEqual([
      'img2vid',
      'frames2vid',
      'keys2vid',
      'ref2vid',
      'fuse2vid',
      'vid2vid',
      'vid2vid',
      'motion2vid',
      'char2vid',
      'charswap',
      'audio2vid'
    ]);
    expect(groups.flatMap((group) => group.modes)).toHaveLength(
      new Set(VIDEO_CURRENT_ENTRIES.map((entry) => entry.workflow)).size
    );
  });

  test('MODE-03 keeps the image studio on its two documented intents', () => {
    const groups = studioModeGroups(IMAGE_REGISTRY_ENTRIES.map((entry) => entry.workflow));
    expect(groups.map((group) => [group.key, group.modes.map((mode) => mode.workflow)])).toEqual([
      ['create', ['text-to-image']],
      ['edit', ['image-edit']]
    ]);
    expect(studioModeLabel('image-edit')).toBe('Edit an image');
  });

  test('MODE-04 keeps an uncatalogued workflow selectable in a trailing group', () => {
    const groups = studioModeGroups(['text-to-video', 'hologram-to-video']);
    expect(groups.map((group) => group.key)).toEqual(['create', 'other']);
    expect(groups[1]?.modes[0]).toEqual({
      workflow: 'hologram-to-video',
      group: 'other',
      label: 'hologram to video',
      tag: 'hologram2video'
    });
  });

  test('MODE-05 drops duplicate workflows and empty groups', () => {
    const groups = studioModeGroups(['image-edit', 'image-edit']);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.modes).toHaveLength(1);
  });
});
