<script lang="ts">
import AppIcon from '$lib/components/ui/AppIcon.svelte';
import Badge from '$lib/components/ui/Badge.svelte';
import Button from '$lib/components/ui/Button.svelte';
import LinkButton from '$lib/components/ui/LinkButton.svelte';
import Sheet from '$lib/components/ui/Sheet.svelte';

interface Props {
  kind: 'image' | 'video';
}

let { kind }: Props = $props();
let setupOpen = $state(false);

let isImage = $derived(kind === 'image');
let outputLabel = $derived(isImage ? 'image' : 'video');
let title = $derived(isImage ? 'Set up an image workflow' : 'Set up a video workflow');
let description = $derived(
  isImage
    ? 'Choose a documented workflow and model before adding prompts or source images.'
    : 'Choose a documented workflow and model before adding prompts, frames or source video.'
);
</script>

{#snippet inspectorContent()}
  <div class="flex min-h-full flex-col">
    <div class="flex-1 px-5 py-5">
      <section aria-labelledby={`${kind}-setup-heading`}>
        <p class="eyebrow-label">Essential</p>
        <h2 id={`${kind}-setup-heading`} class="mt-1 text-base font-semibold tracking-tight">
          Workflow and model
        </h2>
        <p class="mt-2 text-sm leading-6 text-muted-foreground">
          The guided controls are driven by the audited local model registry. No model capability is
          assumed before that registry is available.
        </p>

        <div class="mt-4 rounded-[var(--radius)] bg-muted px-3 py-3">
          <div class="flex items-start gap-3">
            <AppIcon name="pending" size={18} class="mt-0.5 shrink-0 text-muted-foreground" />
            <div>
              <p class="text-sm font-semibold">Model registry not loaded</p>
              <p class="mt-1 text-xs leading-5 text-muted-foreground">
                Model-specific inputs, validation and request previews will appear here when
                verified.
              </p>
            </div>
          </div>
        </div>

        <LinkButton href="/models" variant="outline" class="mt-4 w-full">
          Review model catalogue
          <AppIcon name="arrow-right" size={16} />
        </LinkButton>
      </section>

      <section class="mt-6 border-t border-border pt-5" aria-labelledby={`${kind}-summary-heading`}>
        <p class="eyebrow-label">Request</p>
        <h2 id={`${kind}-summary-heading`} class="mt-1 text-sm font-semibold">
          Submission summary
        </h2>
        <dl class="mt-3 grid gap-2 text-sm">
          <div class="flex items-center justify-between gap-4">
            <dt class="text-muted-foreground">Model</dt>
            <dd class="font-medium">Required</dd>
          </div>
          <div class="flex items-center justify-between gap-4">
            <dt class="text-muted-foreground">Estimated credits</dt>
            <dd class="font-medium">Unavailable</dd>
          </div>
          <div class="flex items-center justify-between gap-4">
            <dt class="text-muted-foreground">Balance</dt>
            <dd class="font-medium">Not connected</dd>
          </div>
        </dl>
      </section>
    </div>

    <div
      class="sticky bottom-0 border-t border-border bg-card px-5 py-4 shadow-[0_-8px_20px_hsl(0_0%_0%/0.04)]"
    >
      <p id={`${kind}-generate-reason`} class="mb-3 text-xs leading-5 text-muted-foreground">
        Select an audited model before generating. No paid request can be sent from this empty
        state.
      </p>
      <Button variant="primary" class="w-full" disabled ariaDescribedby={`${kind}-generate-reason`}>
        Generate {outputLabel}
      </Button>
    </div>
  </div>
{/snippet}

<div class="studio-layout">
  <section
    class="min-w-0 px-3 py-4 sm:px-5 sm:py-5 xl:px-6"
    aria-labelledby={`${kind}-stage-heading`}
  >
    <div
      class="mb-3 flex min-h-10 items-center justify-between gap-3 border-y border-border py-2 text-xs"
      role="group"
      aria-label="Generation lifecycle"
    >
      <div class="flex min-w-0 items-center gap-2">
        <Badge tone="info">
          <AppIcon name="pending" size={12} />
          Compose
        </Badge>
        <span class="truncate text-muted-foreground">No task submitted</span>
      </div>
      <span class="hidden text-muted-foreground sm:inline">Local draft only</span>
    </div>

    <div class="media-stage grid place-items-center px-5 py-10 text-center">
      <div class="max-w-md">
        <div
          class="mx-auto grid size-12 place-items-center rounded-lg bg-stage-elevated text-stage-foreground"
        >
          <AppIcon name={kind} size={23} />
        </div>
        <h2
          id={`${kind}-stage-heading`}
          class="mt-5 text-xl font-semibold tracking-tight text-stage-foreground"
        >
          {title}
        </h2>
        <p class="mx-auto mt-2 max-w-sm font-serif text-base leading-7 text-stage-muted">
          {description}
        </p>
        <div class="mt-6 flex flex-wrap justify-center gap-2">
          <LinkButton
            href="/models"
            variant="outline"
            class="border-stage-border bg-stage-elevated text-stage-foreground hover:bg-stage-border"
          >
            Explore models
          </LinkButton>
          <LinkButton
            href="/presets"
            variant="ghost"
            class="text-stage-muted hover:bg-stage-elevated hover:text-stage-foreground"
          >
            View presets
          </LinkButton>
        </div>
      </div>
    </div>

    <div
      class="studio-mobile-setup mt-3 items-center justify-between gap-4 rounded-[var(--radius)] bg-muted px-4 py-3"
    >
      <div class="min-w-0">
        <p class="text-sm font-semibold">Workflow setup</p>
        <p class="truncate text-xs text-muted-foreground">Model required · estimate unavailable</p>
      </div>
      <Sheet
        bind:open={setupOpen}
        title={`${isImage ? 'Image' : 'Video'} setup`}
        description="Guided workflow controls and an honest request summary."
        side="right"
        triggerClass="focus-ring inline-flex min-h-9 shrink-0 items-center gap-2 rounded-[var(--radius)] border border-border bg-background px-3 text-sm font-semibold shadow-[var(--shadow-xs)] hover:bg-muted"
        contentClass="p-0"
        studioSheet
      >
        {#snippet trigger()}
          <AppIcon name="filters" size={16} />
          Edit setup
        {/snippet}
        <div id="parameter-inspector-mobile" class="min-h-[calc(100dvh-5rem)]">
          {@render inspectorContent()}
        </div>
      </Sheet>
    </div>
  </section>

  <aside id="parameter-inspector" class="studio-inspector" aria-label="Parameter inspector">
    {@render inspectorContent()}
  </aside>
</div>
