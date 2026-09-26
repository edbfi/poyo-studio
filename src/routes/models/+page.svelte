<script lang="ts">
import AppIcon from '$lib/components/ui/AppIcon.svelte';
import Badge from '$lib/components/ui/Badge.svelte';
import LinkButton from '$lib/components/ui/LinkButton.svelte';
</script>

<svelte:head>
  <title>Models · Poyo Local Studio</title>
  <meta name="description" content="Search the audited Poyo image and video model catalogue.">
</svelte:head>

<div class="route-shell">
  <section aria-labelledby="model-catalogue-heading">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <p class="eyebrow-label">Audited capabilities</p>
        <h2 id="model-catalogue-heading" class="mt-1 text-base font-semibold tracking-tight">
          Model catalogue
        </h2>
        <p class="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Public model IDs, workflow variants, media roles and documentation conflicts will be
          reviewed here.
        </p>
      </div>
      <Badge tone="neutral">Registry not loaded</Badge>
    </div>

    <div class="mt-5 flex flex-col gap-2 border-y border-border py-3 sm:flex-row">
      <form action="/models" method="GET" class="relative min-w-0 flex-1">
        <label for="model-search" class="sr-only">Search models</label>
        <AppIcon
          name="search"
          size={16}
          class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
        />
        <input
          id="model-search"
          name="q"
          type="search"
          class="focus-ring h-9 w-full rounded-[var(--radius)] border border-input bg-background pr-3 pl-9 text-sm"
          placeholder="Search name, provider, model ID or workflow"
        >
      </form>
      <button
        type="button"
        class="focus-ring inline-flex min-h-9 items-center justify-center gap-2 rounded-[var(--radius)] border border-border bg-background px-3 text-sm font-semibold shadow-[var(--shadow-xs)]"
      >
        <AppIcon name="filters" size={16} />
        Filters
      </button>
    </div>

    <div class="py-12 sm:py-16">
      <div class="mx-auto max-w-xl text-center">
        <div
          class="mx-auto grid size-11 place-items-center rounded-lg bg-muted text-muted-foreground"
        >
          <AppIcon name="models" size={21} />
        </div>
        <h3 class="mt-4 text-base font-semibold">The local model registry is unavailable</h3>
        <p class="mt-2 font-serif text-base leading-7 text-muted-foreground">
          Models will appear only after their workflow, inputs, validation, payload adapter and
          documentation sources have been audited.
        </p>
        <LinkButton href="/settings/diagnostics" variant="outline" class="mt-5">
          Open registry diagnostics
          <AppIcon name="arrow-right" size={16} />
        </LinkButton>
      </div>
    </div>
  </section>
</div>
