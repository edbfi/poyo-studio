<script lang="ts">
import AppIcon from '$lib/components/ui/AppIcon.svelte';
import Badge from '$lib/components/ui/Badge.svelte';
import { dateTimeLabel } from '$lib/features/library/presentation';
import type { PublicIpv4StatusDto } from '$lib/features/settings/public-ipv4-guard';

interface Props {
  status: PublicIpv4StatusDto;
  checking?: boolean;
  compact?: boolean;
  onrefresh: () => void;
}

let { status, checking = false, compact = false, onrefresh }: Props = $props();

let label = $derived(
  checking
    ? 'Checking public IP'
    : status.state === 'guard-disabled'
      ? 'IP guard off'
      : status.state === 'protected'
        ? 'IP differs from home'
        : status.state === 'blocked'
          ? 'Home IP detected'
          : status.state === 'misconfigured'
            ? 'IP guard needs attention'
            : 'Public IP unavailable'
);
let tone = $derived<'neutral' | 'success' | 'danger' | 'warning'>(
  status.state === 'protected'
    ? 'success'
    : status.state === 'blocked'
      ? 'danger'
      : status.state === 'unavailable' || status.state === 'misconfigured'
        ? 'warning'
        : 'neutral'
);
</script>

<div class="min-w-0" aria-live="polite" aria-atomic="true">
  <div class="flex min-w-0 items-center gap-2">
    <AppIcon name={status.state === 'blocked' || status.state === 'misconfigured' ? 'shield' : 'wifi'} size={16} />
    <div class={compact ? 'hidden min-w-0 flex-1 sm:block' : 'min-w-0 flex-1'}>
      <div class="flex min-w-0 items-center gap-1.5">
        <a
          href="/settings#public-ip-guard"
          aria-label="Configure exact IP guard"
          class="focus-ring inline-flex min-w-0 rounded no-underline"
        >
          <Badge {tone} class="max-w-full truncate">{label}</Badge>
        </a>
        {#if compact}
          <span class="truncate font-mono text-[0.6875rem] text-foreground">
            {status.currentIpv4 ?? 'No address'}
          </span>
        {/if}
      </div>
      {#if !compact}
        <p class="mt-1 truncate font-mono text-[0.6875rem] text-foreground">
          {status.currentIpv4 ?? 'Address not available'}
        </p>
        <p class="mt-0.5 truncate text-[0.625rem] text-muted-foreground">
          {status.checkedAt ? `Checked ${dateTimeLabel(status.checkedAt)}` : 'Not checked'}
        </p>
      {/if}
    </div>
    <button
      type="button"
      class="focus-ring grid size-8 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background/70 hover:text-foreground disabled:opacity-50"
      aria-label="Refresh outbound public IPv4 status"
      title="Refresh public IP"
      disabled={checking}
      onclick={onrefresh}
    >
      <AppIcon name="refresh" size={14} />
    </button>
  </div>
</div>
