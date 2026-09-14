<script lang="ts">
import { onMount } from 'svelte';
import AppIcon from '$lib/components/ui/AppIcon.svelte';
import {
  isThemePreference,
  nextThemePreference,
  resolveTheme,
  type ThemePreference,
  themeStorageKey
} from '$lib/theme';

interface Props {
  showLabel?: boolean;
  class?: string;
}

let { showLabel = true, class: className = '' }: Props = $props();
let preference = $state<ThemePreference>('light');
let systemPrefersDark = $state(false);
let mediaQuery: MediaQueryList | undefined;

const labels: Record<ThemePreference, string> = {
  light: 'Light theme',
  dark: 'Dark theme',
  system: 'System theme'
};

let label = $derived(labels[preference]);

function applyTheme(next: ThemePreference): void {
  const resolved = resolveTheme(next, systemPrefersDark);
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = next;
}

function setPreference(next: ThemePreference): void {
  preference = next;
  localStorage.setItem(themeStorageKey, next);
  applyTheme(next);
}

function cycleTheme(): void {
  setPreference(nextThemePreference(preference));
}

onMount(() => {
  mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  systemPrefersDark = mediaQuery.matches;
  const stored = localStorage.getItem(themeStorageKey);
  preference = isThemePreference(stored) ? stored : 'light';
  applyTheme(preference);

  const handleSystemChange = (event: MediaQueryListEvent): void => {
    systemPrefersDark = event.matches;
    if (preference === 'system') applyTheme(preference);
  };

  mediaQuery.addEventListener('change', handleSystemChange);
  return () => mediaQuery?.removeEventListener('change', handleSystemChange);
});
</script>

<button
  type="button"
  class={`focus-ring inline-flex min-h-9 items-center gap-2 rounded-[var(--radius)] px-2.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground ${className}`}
  aria-label={`${label}. Activate next theme.`}
  title={`${label}. Activate next theme.`}
  data-theme-preference={preference}
  onclick={cycleTheme}
>
  <AppIcon name={preference} size={17} />
  {#if showLabel}
    <span>{label}</span>
  {/if}
</button>
