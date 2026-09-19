<script lang="ts">
import { coerceFieldValue } from '$lib/features/generation/studio-controller';
import type { FieldDefinition } from '$lib/features/registry/types';

interface Props {
  field: FieldDefinition;
  value: unknown;
  onchange: (key: string, value: unknown) => void;
}

let { field, value, onchange }: Props = $props();
let structuredDraft = $state('');
let structuredError = $state('');

let label = $derived(
  field.key.replace(/([A-Z])/g, ' $1').replace(/^./, (character) => character.toUpperCase())
);
let id = $props.id();

function updateStructured(event: Event): void {
  structuredDraft = (event.currentTarget as HTMLTextAreaElement).value;
  try {
    const parsed = structuredDraft.trim() ? JSON.parse(structuredDraft) : undefined;
    structuredError = '';
    onchange(field.key, parsed);
  } catch {
    structuredError = 'Enter valid JSON before previewing this field.';
  }
}
</script>

<div class="grid gap-1.5">
  {#if field.kind === 'boolean'}
    <label class="flex min-h-10 cursor-pointer items-center justify-between gap-4" for={id}>
      <span>
        <span class="block text-sm font-semibold">{label}</span>
        {#if field.key === 'enableSafetyChecker'}
          <span class="mt-0.5 block text-xs text-muted-foreground">Off by Poyo Local Studio default.</span>
        {:else if field.description}
          <span class="mt-0.5 block text-xs text-muted-foreground">{field.description}</span>
        {/if}
      </span>
      <span class="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
        {value === true ? 'On' : 'Off'}
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={value === true}
          class="focus-ring h-5 w-9 appearance-none rounded-full bg-input p-0.5 transition-colors before:block before:size-4 before:rounded-full before:bg-background before:shadow-sm before:transition-transform checked:bg-primary checked:before:translate-x-4"
          onchange={(event) => onchange(field.key, event.currentTarget.checked)}
        />
      </span>
    </label>
  {:else}
    <label for={id} class="text-xs font-semibold text-foreground">
      {label}{field.required ? ' *' : ''}
    </label>
    {#if field.kind === 'enum'}
      <select
        id={id}
        class="focus-ring h-9 w-full rounded-[var(--radius)] border border-input bg-background px-2.5 text-sm"
        value={value === undefined ? '' : String(value)}
        onchange={(event) => onchange(field.key, coerceFieldValue(field, event.currentTarget.value))}
      >
        {#if !field.required}<option value="">Automatic</option>{/if}
        {#each field.enum ?? [] as option (option)}
          <option value={option}>{option}</option>
        {/each}
      </select>
    {:else if field.kind === 'text'}
      <textarea
        id={id}
        rows={field.key === 'prompt' ? 5 : 3}
        class="focus-ring w-full resize-y rounded-[var(--radius)] border border-input bg-background px-3 py-2 text-sm leading-6"
        value={typeof value === 'string' ? value : ''}
        maxlength={field.max}
        aria-describedby={field.description ? `${id}-description` : undefined}
        oninput={(event) => onchange(field.key, event.currentTarget.value)}
      ></textarea>
    {:else if field.kind === 'dimensions'}
      <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <input
          id={id}
          type="number"
          min="1"
          class="focus-ring h-9 min-w-0 rounded-[var(--radius)] border border-input bg-background px-2.5 text-sm"
          value={typeof value === 'object' && value ? String((value as Record<string, unknown>).width ?? '') : ''}
          aria-label="Custom width"
          oninput={(event) =>
            onchange('width', event.currentTarget.value ? Number(event.currentTarget.value) : undefined)}
        />
        <span class="text-muted-foreground" aria-hidden="true">×</span>
        <input
          type="number"
          min="1"
          class="focus-ring h-9 min-w-0 rounded-[var(--radius)] border border-input bg-background px-2.5 text-sm"
          value={typeof value === 'object' && value ? String((value as Record<string, unknown>).height ?? '') : ''}
          aria-label="Custom height"
          oninput={(event) =>
            onchange('height', event.currentTarget.value ? Number(event.currentTarget.value) : undefined)}
        />
      </div>
    {:else if field.kind === 'object-list' || field.kind === 'elements' || field.kind === 'string-list'}
      <textarea
        id={id}
        rows="4"
        class="focus-ring w-full resize-y rounded-[var(--radius)] border border-input bg-background px-3 py-2 font-mono text-xs leading-5"
        value={structuredDraft || (value === undefined ? '' : JSON.stringify(value, null, 2))}
        aria-invalid={structuredError ? 'true' : undefined}
        aria-describedby={structuredError ? `${id}-error` : undefined}
        oninput={updateStructured}
      ></textarea>
      {#if structuredError}<p id={`${id}-error`} class="text-xs text-destructive">{structuredError}</p>{/if}
    {:else}
      <input
        id={id}
        type="number"
        min={field.min}
        max={field.max}
        step={field.kind === 'integer' ? 1 : 'any'}
        class="focus-ring h-9 w-full rounded-[var(--radius)] border border-input bg-background px-2.5 text-sm"
        value={typeof value === 'number' ? value : ''}
        oninput={(event) => onchange(field.key, coerceFieldValue(field, event.currentTarget.value))}
      />
    {/if}
    {#if field.description}
      <p id={`${id}-description`} class="text-xs leading-5 text-muted-foreground">{field.description}</p>
    {/if}
    {#if field.max && field.kind === 'text'}
      <p class="text-right text-[0.6875rem] text-muted-foreground">
        {typeof value === 'string' ? value.length : 0} / {field.max}
      </p>
    {/if}
  {/if}
</div>
