<script lang="ts">
import { coerceFieldValue } from '$lib/features/generation/studio-controller';
import type { AutomaticFieldChoice } from '$lib/features/generation/studio-sizing';
import type { FieldDefinition } from '$lib/features/registry/types';

interface Props {
  field: FieldDefinition;
  value: unknown;
  automatic: boolean;
  automaticChoice: AutomaticFieldChoice;
  onchange: (key: string, value: unknown, automatic: boolean) => void;
}

let { field, value, automatic, automaticChoice, onchange }: Props = $props();
let id = $props.id();
let label = $derived(
  field.key.replace(/([A-Z])/g, ' $1').replace(/^./, (character) => character.toUpperCase())
);
let options = $derived((field.enum ?? []).filter((option) => option !== 'auto'));
let compact = $derived(options.length <= 12);
</script>

<fieldset class="grid gap-2" aria-describedby={`${id}-description`}>
  <legend class="text-xs font-semibold text-foreground">{label}{field.required ? ' *' : ''}</legend>
  {#if compact}
    <div class="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
      {#if automaticChoice.available}
        <label
          class="focus-within:ring-2 focus-within:ring-ring col-span-2 flex min-h-10 cursor-pointer items-center justify-center rounded-[var(--radius)] border px-2 text-center text-xs font-semibold sm:col-span-3"
          class:border-primary={automatic}
          class:bg-accent={automatic}
          class:border-border={!automatic}
          class:bg-background={!automatic}
        >
          <input
            class="sr-only"
            type="radio"
            name={`${id}-choice`}
            value="automatic"
            checked={automatic}
            onchange={() => onchange(field.key, undefined, true)}
          >
          {automaticChoice.label}
        </label>
      {/if}
      {#each options as option (option)}
        <label
          class="focus-within:ring-2 focus-within:ring-ring flex min-h-10 cursor-pointer items-center justify-center rounded-[var(--radius)] border px-2 text-center text-xs font-semibold"
          class:border-primary={!automatic && String(value) === option}
          class:bg-accent={!automatic && String(value) === option}
          class:border-border={automatic || String(value) !== option}
          class:bg-background={automatic || String(value) !== option}
        >
          <input
            class="sr-only"
            type="radio"
            name={`${id}-choice`}
            value={option}
            checked={!automatic && String(value) === option}
            onchange={() => onchange(field.key, coerceFieldValue(field, option), false)}
          >
          {option}
        </label>
      {/each}
    </div>
  {:else}
    <div class="grid gap-1.5">
      {#if automaticChoice.available}
        <label
          class="focus-within:ring-2 focus-within:ring-ring flex min-h-10 cursor-pointer items-center gap-2 rounded-[var(--radius)] border border-border bg-background px-3 text-xs font-semibold"
        >
          <input
            type="radio"
            name={`${id}-mode`}
            checked={automatic}
            onchange={() => onchange(field.key, undefined, true)}
          >
          {automaticChoice.label}
        </label>
      {/if}
      <label class="grid gap-1 text-xs font-semibold" for={id}>
        Explicit {label.toLowerCase()}
        <select
          {id}
          class="focus-ring h-9 w-full rounded-[var(--radius)] border border-input bg-background px-2.5 text-sm"
          value={automatic ? '' : String(value ?? '')}
          onchange={(event) => onchange(field.key, coerceFieldValue(field, event.currentTarget.value), false)}
        >
          <option value="" disabled>Select a value</option>
          {#each options as option (option)}
            <option value={option}>{option}</option>
          {/each}
        </select>
      </label>
    </div>
  {/if}
  <p id={`${id}-description`} class="text-xs leading-5 text-muted-foreground">
    {automatic ? automaticChoice.description : field.description}
  </p>
</fieldset>
