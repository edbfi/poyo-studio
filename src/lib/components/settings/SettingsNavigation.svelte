<script lang="ts">
import AppIcon from '#lib/components/ui/AppIcon.svelte';
import { settingsNavigation } from '#lib/navigation.js';
import { goto } from '$app/navigation';

interface Props {
  current: '/settings' | '/settings/diagnostics';
}

let { current }: Props = $props();
</script>

<div>
  <label class="mb-5 block lg:hidden">
    <span class="mb-1.5 block text-xs font-semibold text-muted-foreground">Settings section</span>
    <select
      class="focus-ring h-10 w-full rounded border border-input bg-background px-3 text-sm font-semibold"
      value={current}
      onchange={(event) => void goto(event.currentTarget.value)}
    >
      {#each settingsNavigation as item (item.href)}
        <option value={item.href}>{item.label}</option>
      {/each}
    </select>
  </label>

  <nav aria-label="Settings sections" class="hidden border-r border-border pr-5 lg:block">
    <p class="eyebrow-label mb-2">Application</p>
    <ul class="m-0 grid list-none gap-1 p-0">
      {#each settingsNavigation as item (item.href)}
        <li>
          <a
            href={item.href}
            class={`focus-ring flex min-h-9 items-center gap-2 rounded px-2.5 text-sm font-semibold no-underline ${item.href === current ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
            aria-current={item.href === current ? 'page' : undefined}
          >
            <AppIcon name={item.icon} size={16} />
            {item.label}
          </a>
        </li>
      {/each}
    </ul>
  </nav>
</div>
