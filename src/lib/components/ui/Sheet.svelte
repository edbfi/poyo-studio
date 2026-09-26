<script lang="ts">
import { Dialog } from 'bits-ui';
import type { Snippet } from 'svelte';

interface Props {
  title: string;
  description: string;
  trigger: Snippet;
  children: Snippet;
  open?: boolean;
  side?: 'right' | 'bottom';
  triggerClass?: string;
  contentClass?: string;
  studioSheet?: boolean;
}

let {
  title,
  description,
  trigger,
  children,
  open = $bindable(false),
  side = 'right',
  triggerClass = '',
  contentClass = '',
  studioSheet = false
}: Props = $props();
</script>

<Dialog.Root bind:open>
  <Dialog.Trigger class={triggerClass}> {@render trigger()} </Dialog.Trigger>
  <Dialog.Portal>
    <Dialog.Overlay class="sheet-overlay" />
    <Dialog.Content
      class={`sheet-content ${contentClass}`}
      data-side={side}
      data-studio-sheet={studioSheet ? 'true' : undefined}
    >
      <div class="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div class="min-w-0">
          <Dialog.Title class="text-base font-semibold tracking-tight">{title}</Dialog.Title>
          <Dialog.Description class="mt-1 text-sm leading-5 text-muted-foreground">
            {description}
          </Dialog.Description>
        </div>
        <Dialog.Close
          class="focus-ring inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--radius)] text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Close panel"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </Dialog.Close>
      </div>
      {@render children()}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
