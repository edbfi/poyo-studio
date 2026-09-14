<script lang="ts">
import { untrack } from 'svelte';
import AppIcon from '$lib/components/ui/AppIcon.svelte';
import Badge from '$lib/components/ui/Badge.svelte';
import Button from '$lib/components/ui/Button.svelte';
import LinkButton from '$lib/components/ui/LinkButton.svelte';
import { studioModeLabel } from '$lib/features/generation/studio-modes';
import type { PresetRecord } from '$lib/features/presets/types';
import type { PageData } from './$types';

let { data }: { data: PageData } = $props();
const initialPresets = untrack(() => data.presets);
let presets = $state<PresetRecord[]>([...initialPresets]);
let deletingId = $state<string | null>(null);
let deleteError = $state('');

function modelLabel(entryKey: string): string {
  const model = data.catalog.find((item) => item.key === entryKey);
  return model ? `${model.displayName} · ${model.provider}` : entryKey;
}

function promptFor(preset: PresetRecord): string | null {
  const prompt = preset.values.guided.prompt;
  return typeof prompt === 'string' && prompt.trim() ? prompt : null;
}

async function removePreset(preset: PresetRecord): Promise<void> {
  if (!window.confirm(`Delete preset “${preset.name}”? Source media and jobs are not affected.`))
    return;
  deletingId = preset.id;
  deleteError = '';
  try {
    const response = await fetch(`/api/presets/${encodeURIComponent(preset.id)}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    if (!response.ok) throw new Error('Preset could not be deleted.');
    presets = presets.filter((item) => item.id !== preset.id);
  } catch (error) {
    deleteError = error instanceof Error ? error.message : 'Preset could not be deleted.';
  } finally {
    deletingId = null;
  }
}
</script>

<svelte:head>
  <title>Presets · Poyo Local Studio</title>
  <meta name="description" content="Manage reusable Poyo generation configurations." />
</svelte:head>

<div class="route-shell">
  <section aria-labelledby="preset-list-heading">
    <div class="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
      <div>
        <p class="eyebrow-label">Reusable setup</p>
        <h2 id="preset-list-heading" class="mt-1 text-base font-semibold tracking-tight">Saved presets</h2>
        <p class="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Presets retain guided settings and input-role URLs, never large source media or credentials.
        </p>
      </div>
      <div class="flex gap-2">
        <LinkButton href="/studio/image" variant="primary">New image preset</LinkButton>
        <LinkButton href="/studio/video" variant="outline">New video preset</LinkButton>
      </div>
    </div>

    {#if deleteError}<p class="mt-4 text-sm text-destructive" role="alert">{deleteError}</p>{/if}

    {#if presets.length}
      <ul class="mt-5 grid list-none gap-3 p-0 md:grid-cols-2 2xl:grid-cols-3">
        {#each presets as preset (preset.id)}
          <li class="flex min-h-56 flex-col rounded-[var(--radius)] border border-border bg-card p-4 shadow-[var(--shadow-xs)]">
            <div class="flex items-start justify-between gap-3">
              <div class="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                <AppIcon name={preset.values.modality} size={18} />
              </div>
              <Badge tone={preset.values.modality === 'image' ? 'info' : 'experimental'}>{preset.values.modality}</Badge>
            </div>
            <h3 class="mt-4 text-base font-semibold tracking-tight">{preset.name}</h3>
            <p class="mt-1 text-xs font-semibold text-muted-foreground">{modelLabel(preset.entryKey)}</p>
            <p class="mt-2 line-clamp-2 text-sm leading-6 text-muted-foreground">
              {preset.description ?? promptFor(preset) ?? studioModeLabel(preset.workflow)}
            </p>
            <div class="mt-3 flex flex-wrap gap-1.5">
              <Badge tone="neutral">{studioModeLabel(preset.workflow)}</Badge>
              {#if preset.values.guided.enableSafetyChecker !== undefined}
                <Badge tone="neutral">Safety {preset.values.guided.enableSafetyChecker ? 'on' : 'off'}</Badge>
              {/if}
              {#if preset.values.expertOverrides.length}<Badge tone="experimental">Expert overrides</Badge>{/if}
            </div>
            <div class="mt-auto flex items-center justify-between gap-3 pt-5">
              <span class="text-[0.6875rem] text-muted-foreground">Updated {new Date(preset.updatedAt).toLocaleDateString()}</span>
              <div class="flex gap-2">
                <Button variant="ghost" size="sm" disabled={deletingId === preset.id} onclick={() => removePreset(preset)}>
                  {deletingId === preset.id ? 'Deleting…' : 'Delete'}
                </Button>
                <LinkButton href={`/studio/${preset.values.modality}?preset=${encodeURIComponent(preset.id)}`} variant="outline">Use preset</LinkButton>
              </div>
            </div>
          </li>
        {/each}
      </ul>
    {:else}
      <div class="grid min-h-[28rem] place-items-center py-12 text-center">
        <div class="max-w-lg">
          <div class="mx-auto grid size-11 place-items-center rounded-lg bg-muted text-muted-foreground">
            <AppIcon name="presets" size={21} />
          </div>
          <h3 class="mt-4 text-base font-semibold">No presets saved</h3>
          <p class="mt-2 font-serif text-base leading-7 text-muted-foreground">
            Save a verified model configuration from either studio, then reuse it without rebuilding every compatible option.
          </p>
        </div>
      </div>
    {/if}
  </section>
</div>
