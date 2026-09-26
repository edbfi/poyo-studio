<script lang="ts">
import type { Snippet } from 'svelte';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'experimental' | 'stage';

interface Props {
  children: Snippet;
  tone?: Tone;
  class?: string;
}

let { children, tone = 'neutral', class: className = '' }: Props = $props();

const tones: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  info: 'bg-accent text-accent-foreground',
  success: 'bg-success/12 text-success',
  warning: 'bg-warning/12 text-warning',
  danger: 'bg-destructive/12 text-destructive',
  experimental: 'bg-experimental/12 text-experimental',
  stage: 'bg-stage-elevated text-stage-foreground'
};

let classes = $derived(
  `inline-flex min-h-5 items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold leading-none ${tones[tone]} ${className}`
);
</script>

<span class={classes}> {@render children()} </span>
