import extractorSvelte from '@unocss/extractor-svelte';
import { presetWind4 } from '@unocss/preset-wind4';
import { defineConfig } from 'unocss';

export default defineConfig({
  extractors: [extractorSvelte()],
  presets: [
    presetWind4({
      preflights: {
        reset: true
      }
    })
  ],
  content: {
    pipeline: {
      include: [/\.svelte(?:\.(?:ts|js))?$/, /\.[jt]s$/]
    }
  },
  theme: {
    colors: {
      background: 'var(--background)',
      foreground: 'var(--foreground)',
      card: 'var(--card)',
      'card-foreground': 'var(--card-foreground)',
      popover: 'var(--popover)',
      'popover-foreground': 'var(--popover-foreground)',
      primary: 'var(--primary)',
      'primary-foreground': 'var(--primary-foreground)',
      secondary: 'var(--secondary)',
      'secondary-foreground': 'var(--secondary-foreground)',
      muted: 'var(--muted)',
      'muted-foreground': 'var(--muted-foreground)',
      accent: 'var(--accent)',
      'accent-foreground': 'var(--accent-foreground)',
      destructive: 'var(--destructive)',
      'destructive-foreground': 'var(--destructive-foreground)',
      border: 'var(--border)',
      input: 'var(--input)',
      ring: 'var(--ring)',
      sidebar: 'var(--sidebar)',
      'sidebar-foreground': 'var(--sidebar-foreground)',
      stage: 'var(--stage)',
      'stage-elevated': 'var(--stage-elevated)',
      'stage-foreground': 'var(--stage-foreground)',
      'stage-muted': 'var(--stage-muted)',
      'stage-border': 'var(--stage-border)',
      success: 'var(--success)',
      warning: 'var(--warning)',
      experimental: 'var(--experimental)'
    },
    // presetWind4 reads `font`, not `fontFamily`, and emits each stack as `--font-*`.
    font: {
      sans: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      serif: '"Source Serif 4", ui-serif, Georgia, Cambria, serif',
      mono: '"JetBrains Mono", ui-monospace, "SFMono-Regular", Consolas, monospace'
    },
    radius: {
      sm: '0.25rem',
      DEFAULT: 'var(--radius)',
      md: '0.5rem'
    }
  },
  shortcuts: {
    'focus-ring':
      'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    'surface-control':
      'border border-border bg-background text-foreground shadow-[var(--shadow-xs)]',
    'route-shell': 'mx-auto w-full max-w-[1440px] px-4 py-5 sm:px-6 sm:py-7 xl:px-8',
    'eyebrow-label':
      'text-[0.6875rem] font-semibold tracking-[0.11em] text-muted-foreground uppercase',
    'section-heading': 'text-sm font-semibold tracking-tight text-foreground'
  }
});
