<script lang="ts">
import AppIcon from '#lib/components/ui/AppIcon.svelte';
import { parseAspectRatioPresentation } from '#lib/features/generation/aspect-ratio-presentation.js';
import { coerceFieldValue } from '#lib/features/generation/studio-controller.js';
import type { AutomaticFieldChoice } from '#lib/features/generation/studio-sizing.js';
import { explicitRatioTokens } from '#lib/features/registry/ratio-resolver.js';
import type { FieldDefinition } from '#lib/features/registry/types.js';

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
let options = $derived(explicitRatioTokens(field.enum ?? []));
</script>

<fieldset class="grid gap-2" aria-describedby={`${id}-description`}>
  <legend class="text-xs font-semibold text-foreground">{label}{field.required ? ' *' : ''}</legend>
  <div class="flex flex-wrap gap-1.5">
    {#if automaticChoice.available}
      <label
        class="focus-within:ring-2 focus-within:ring-ring flex min-h-10 min-w-28 cursor-pointer items-center justify-center gap-1.5 rounded-[var(--radius)] border px-2 text-center text-xs font-semibold max-sm:min-h-11"
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
          required={field.required}
          onchange={() => onchange(field.key, undefined, true)}
        >
        <span>{automaticChoice.label}</span>
        <!-- The check slot is always laid out so selecting a tile never reflows the wrapped rows. -->
        <span
          class="flex size-3.5 shrink-0 items-center justify-center"
          class:invisible={!automatic}
        >
          <AppIcon name="success" size={14} />
        </span>
      </label>
    {/if}
    {#each options as option (option)}
      {@const presentation = parseAspectRatioPresentation(option)}
      {@const selected = !automatic && String(value) === option}
      <label
        class="focus-within:ring-2 focus-within:ring-ring flex min-h-10 min-w-20 cursor-pointer items-center gap-2 rounded-[var(--radius)] border px-2 text-xs font-semibold max-sm:min-h-11"
        class:border-primary={selected}
        class:bg-accent={selected}
        class:border-border={!selected}
        class:bg-background={!selected}
      >
        <input
          class="sr-only"
          type="radio"
          name={`${id}-choice`}
          value={option}
          checked={selected}
          required={field.required}
          onchange={() => onchange(field.key, coerceFieldValue(field, option), false)}
        >
        {#if presentation}
          <span class="flex h-8 w-14 shrink-0 items-center justify-center" aria-hidden="true">
            <span
              class="max-h-full max-w-full border-2 border-current"
              style={`height: 100%; aspect-ratio: ${presentation.value};`}
            ></span>
          </span>
        {/if}
        <span>{option}</span>
        <span
          class="flex size-3.5 shrink-0 items-center justify-center"
          class:invisible={!selected}
        >
          <AppIcon name="success" size={14} />
        </span>
      </label>
    {/each}
  </div>
  <p id={`${id}-description`} class="text-xs leading-5 text-muted-foreground">
    {automatic ? automaticChoice.description : field.description}
  </p>
</fieldset>
