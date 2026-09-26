<script lang="ts">
import StudioWorkspace from '$lib/components/studio/StudioWorkspace.svelte';
import type { PageData } from './$types';

let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>Image Studio · Poyo Local Studio</title>
  <meta name="description" content="Compose documented Poyo image generation workflows.">
</svelte:head>

<StudioWorkspace {data} />
