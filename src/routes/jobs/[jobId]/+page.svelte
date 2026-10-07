<script lang="ts">
import { onMount } from 'svelte';
import JobDetailView from '#lib/components/library/JobDetailView.svelte';
import { nextMonotonicEventId } from '#lib/features/generation/studio-controller.js';
import { shouldRefreshJobDetail } from '#lib/features/library/job-detail-events.js';
import { invalidateAll } from '$app/navigation';
import type { PageData } from './$types';

let { data }: { data: PageData } = $props();
let lastEventId = -1;

function acceptDurableEvent(event: MessageEvent<string>): boolean {
  const next = nextMonotonicEventId(lastEventId, event.lastEventId);
  if (next === null) return false;
  lastEventId = next;
  return true;
}

onMount(() => {
  const events = new EventSource('/api/events/jobs');
  events.addEventListener('snapshot', (event) => {
    acceptDurableEvent(event as MessageEvent<string>);
  });
  events.addEventListener('job', (event) => {
    const jobEvent = event as MessageEvent<string>;
    if (!acceptDurableEvent(jobEvent)) return;
    if (!shouldRefreshJobDetail(jobEvent.data, data.job.id, data.job.modality)) return;
    void invalidateAll();
  });
  return () => events.close();
});
</script>

<svelte:head><title>{data.job.displayName} · Activity · Poyo Local Studio</title></svelte:head>
{#key data.job.id}
  <JobDetailView job={data.job} imageNavigation={data.imageNavigation} />
{/key}
