<script lang="ts">
export type AppIconName =
  | 'activity'
  | 'arrow-right'
  | 'home'
  | 'image'
  | 'video'
  | 'jobs'
  | 'library'
  | 'models'
  | 'presets'
  | 'settings'
  | 'diagnostics'
  | 'panel-close'
  | 'panel-open'
  | 'light'
  | 'dark'
  | 'system'
  | 'more'
  | 'wallet'
  | 'success'
  | 'pending'
  | 'search'
  | 'grid'
  | 'list'
  | 'filters'
  | 'upload'
  | 'database'
  | 'shield'
  | 'wifi'
  | 'heart'
  | 'file-search'
  | 'copy'
  | 'server'
  | 'storage'
  | 'folder'
  | 'refresh'
  | 'chevron-right'
  | 'sparkles';

interface Props {
  name: AppIconName;
  size?: number;
  strokeWidth?: number;
  class?: string;
}

let { name, size = 18, strokeWidth = 1.75, class: className = '' }: Props = $props();
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={strokeWidth}
  stroke-linecap="round"
  stroke-linejoin="round"
  class={className}
  aria-hidden="true"
>
  {#if name === 'home'}
    <path d="m3 10 9-7 9 7" />
    <path d="M5 9v11h14V9M9 20v-6h6v6" />
  {:else if name === 'image'}
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="9" r="1.5" />
    <path d="m4 17 4.5-4.5 3.5 3 2.5-2.5L20 18" />
  {:else if name === 'video'}
    <rect x="3" y="5" width="13" height="14" rx="2" />
    <path d="m16 10 5-3v10l-5-3" />
  {:else if name === 'jobs'}
    <path d="M9 6h11M9 12h11M9 18h11" />
    <path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2" />
  {:else if name === 'library'}
    <path d="M4 4h5v16H4zM10 4h5v16h-5zM16 6h4v14h-4z" />
  {:else if name === 'models'}
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <path d="M17.5 14v7M14 17.5h7" />
  {:else if name === 'presets'}
    <path d="M6 3h12v18l-6-4-6 4V3Z" />
  {:else if name === 'settings'}
    <circle cx="12" cy="12" r="3" />
    <path
      d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1A7 7 0 0 0 15 6l-.3-2.6h-4L10.4 6A7 7 0 0 0 9 7L6.5 6 4.6 9.5l2 1.5a7 7 0 0 0 0 2l-2 1.5L6.5 18l2.4-1a7 7 0 0 0 1.5 1l.3 2.6h4L15 18a7 7 0 0 0 1.5-1l2.4 1 2-3.5-2-1.5c.1-.3.1-.7.1-1Z"
    />
  {:else if name === 'diagnostics'}
    <path d="m14 7 3-3 3 3-3 3M10 17l-3 3-3-3 3-3" />
    <path d="M14 4H9a5 5 0 0 0-5 5v1M10 20h5a5 5 0 0 0 5-5v-1" />
  {:else if name === 'panel-close' || name === 'panel-open'}
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
    {#if name === 'panel-close'}
      <path d="m16 9-3 3 3 3" />
    {:else}
      <path d="m14 9 3 3-3 3" />
    {/if}
  {:else if name === 'light'}
    <circle cx="12" cy="12" r="4" />
    <path
      d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
    />
  {:else if name === 'dark'}
    <path d="M20.5 14.2A8 8 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z" />
  {:else if name === 'system'}
    <rect x="3" y="4" width="18" height="13" rx="2" />
    <path d="M8 21h8M12 17v4" />
  {:else if name === 'more'}
    <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
  {:else if name === 'wallet'}
    <path d="M4 6h15a2 2 0 0 1 2 2v10H4a2 2 0 0 1-2-2V6a3 3 0 0 1 3-3h13" />
    <path d="M16 11h5v4h-5a2 2 0 0 1 0-4Z" />
  {:else if name === 'success'}
    <circle cx="12" cy="12" r="9" />
    <path d="m8 12 2.5 2.5L16 9" />
  {:else if name === 'pending' || name === 'activity'}
    <circle cx="12" cy="12" r="9" stroke-dasharray={name === 'pending' ? '3 3' : undefined} />
    {#if name === 'activity'}
      <path d="M7 12h2l1.5-4 3 8 1.5-4h2" />
    {/if}
  {:else if name === 'search' || name === 'file-search'}
    {#if name === 'file-search'}
      <path d="M6 3h8l4 4v5M14 3v5h5" />
    {/if}
    <circle
      cx={name === 'search' ? 10.5 : 11}
      cy={name === 'search' ? 10.5 : 16}
      r={name === 'search' ? 6.5 : 3}
    />
    <path d={name === 'search' ? 'm16 16 5 5' : 'm13.5 18.5 3 3'} />
  {:else if name === 'grid'}
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  {:else if name === 'list'}
    <path d="M8 6h13M8 12h13M8 18h13" />
    <circle cx="4" cy="6" r="1" fill="currentColor" stroke="none" />
    <circle cx="4" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="4" cy="18" r="1" fill="currentColor" stroke="none" />
  {:else if name === 'filters'}
    <path d="M4 6h16M7 12h10M10 18h4" />
  {:else if name === 'upload'}
    <path d="M12 16V3m-4 4 4-4 4 4M4 14v6h16v-6" />
  {:else if name === 'database' || name === 'server' || name === 'storage'}
    {#if name === 'database'}
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" />
    {:else}
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <circle cx="7" cy="7.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="7" cy="16.5" r="1" fill="currentColor" stroke="none" />
    {/if}
  {:else if name === 'shield'}
    <path d="M12 3 20 6v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6l8-3Z" />
    <path d="m8.5 12 2.2 2.2 4.8-5" />
  {:else if name === 'wifi'}
    <path d="M3 9a14 14 0 0 1 18 0M6 13a9 9 0 0 1 12 0M9.5 17a4 4 0 0 1 5 0" />
    <circle cx="12" cy="20" r="1" fill="currentColor" stroke="none" />
  {:else if name === 'heart'}
    <path
      d="M20.8 5.6a5.5 5.5 0 0 0-7.8 0L12 6.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 22l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"
    />
  {:else if name === 'copy'}
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  {:else if name === 'folder'}
    <path d="M3 6h7l2 2h9v11H3V6Z" />
  {:else if name === 'refresh'}
    <path d="M20 7v5h-5M4 17v-5h5" />
    <path d="M6.1 8A7 7 0 0 1 18.5 6.5L20 9M4 15l1.5 2.5A7 7 0 0 0 18 16" />
  {:else if name === 'chevron-right' || name === 'arrow-right'}
    {#if name === 'arrow-right'}
      <path d="M4 12h16" />
    {/if}
    <path d={name === 'arrow-right' ? 'm15 7 5 5-5 5' : 'm9 5 7 7-7 7'} />
  {:else}
    <path
      d="m12 3 1.3 4.7L18 9l-4.7 1.3L12 15l-1.3-4.7L6 9l4.7-1.3L12 3ZM19 15l.7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7L19 15Z"
    />
  {/if}
</svg>
