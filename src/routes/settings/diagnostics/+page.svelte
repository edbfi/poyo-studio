<script lang="ts">
import { untrack } from 'svelte';
import SettingsNavigation from '$lib/components/settings/SettingsNavigation.svelte';
import AppIcon from '$lib/components/ui/AppIcon.svelte';
import Badge from '$lib/components/ui/Badge.svelte';
import type { OperationsDiagnosticsDto } from '$lib/features/diagnostics/contracts';
import { byteSizeLabel, dateTimeLabel } from '$lib/features/library/presentation';
import { diagnosticsReport } from '$lib/features/settings/controller';
import type { PageData } from './$types';

let { data }: { data: PageData } = $props();
let diagnostics = $state<OperationsDiagnosticsDto>(untrack(() => data.diagnostics));
let copied = $state(false);
let refreshing = $state(false);
let errorMessage = $state('');

async function copyReport(): Promise<void> {
  errorMessage = '';
  try {
    await navigator.clipboard.writeText(diagnosticsReport(diagnostics));
    copied = true;
    window.setTimeout(() => (copied = false), 1800);
  } catch {
    errorMessage = 'The browser did not allow clipboard access.';
  }
}

async function refresh(): Promise<void> {
  refreshing = true;
  errorMessage = '';
  try {
    const response = await fetch('/api/diagnostics', { headers: { accept: 'application/json' } });
    const result = (await response.json()) as {
      diagnostics?: OperationsDiagnosticsDto;
      error?: { message?: string };
    };
    if (!response.ok || !result.diagnostics)
      throw new Error(result.error?.message ?? 'Diagnostics refresh failed.');
    diagnostics = result.diagnostics;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Diagnostics refresh failed.';
  } finally {
    refreshing = false;
  }
}
</script>

<svelte:head>
  <title>Diagnostics · Poyo Local Studio</title>
  <meta name="description" content="Inspect safe redacted local application health.">
</svelte:head>

<div class="route-shell">
  <div class="grid gap-8 lg:grid-cols-[13.75rem_minmax(0,50rem)]">
    <SettingsNavigation current="/settings/diagnostics" />

    <section aria-labelledby="diagnostics-heading">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p class="eyebrow-label">Redacted report</p>
          <h2 id="diagnostics-heading" class="mt-1 text-xl font-semibold tracking-tight">
            Application diagnostics
          </h2>
          <p class="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            This view and its copyable report exclude API keys, authorization data, payloads, and
            local filesystem paths.
          </p>
        </div>
        <div class="flex gap-2">
          <button
            type="button"
            onclick={refresh}
            disabled={refreshing}
            class="focus-ring inline-flex min-h-9 items-center gap-2 rounded border border-border bg-background px-3 text-sm font-semibold"
          >
            <AppIcon name="refresh" size={15} /> {refreshing ? 'Refreshing…' : 'Refresh'}
          </button><button
            type="button"
            onclick={copyReport}
            class="focus-ring inline-flex min-h-9 items-center gap-2 rounded border border-border bg-background px-3 text-sm font-semibold"
          >
            <AppIcon name={copied ? 'success' : 'copy'} size={15} />
            {copied ? 'Copied' : 'Copy safe report'}
          </button>
        </div>
      </div>
      {#if errorMessage}
        <p
          class="mt-4 rounded border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          {errorMessage}
        </p>
      {/if}

      <section aria-labelledby="health-heading" class="mt-6 border-y border-border py-5">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p class="eyebrow-label">Snapshot</p>
            <h3 id="health-heading" class="mt-1 section-heading">Health and versions</h3>
          </div>
          <Badge tone={diagnostics.health.status === 'ok' ? 'success' : 'warning'}
            >{diagnostics.health.status}</Badge
          >
        </div>
        <dl class="mt-4 grid gap-4 text-xs sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt class="text-muted-foreground">Checked</dt>
            <dd class="mt-1 font-semibold">{dateTimeLabel(diagnostics.health.checkedAt)}</dd>
          </div>
          <div>
            <dt class="text-muted-foreground">Application</dt>
            <dd class="mt-1 font-mono font-semibold">{diagnostics.health.application.version}</dd>
          </div>
          <div>
            <dt class="text-muted-foreground">Database schema</dt>
            <dd class="mt-1 font-mono font-semibold">
              {diagnostics.health.database.schemaVersion}
            </dd>
          </div>
          <div>
            <dt class="text-muted-foreground">Registry schema</dt>
            <dd class="mt-1 font-mono font-semibold">
              {diagnostics.health.application.registrySchemaVersion}
            </dd>
          </div>
          <div>
            <dt class="text-muted-foreground">SQLite quick check</dt>
            <dd class="mt-1 font-semibold">
              {diagnostics.health.database.status}
              · foreign keys {diagnostics.health.database.foreignKeys ? 'on' : 'off'}
            </dd>
          </div>
          <div>
            <dt class="text-muted-foreground">Listener policy</dt>
            <dd class="mt-1 font-semibold">
              {diagnostics.health.network.defaultHost}
              · loopback only
            </dd>
          </div>
        </dl>
      </section>

      <div class="divide-y divide-border">
        <section class="py-5" aria-labelledby="api-diagnostic-heading">
          <div class="flex flex-wrap items-center gap-2">
            <h3 id="api-diagnostic-heading" class="section-heading">
              Credential and Poyo connectivity
            </h3>
            <Badge tone={diagnostics.health.apiKey.status === 'configured' ? 'success' : 'warning'}
              >{diagnostics.health.apiKey.status}</Badge
            >
          </div>
          <dl class="mt-4 grid gap-4 text-xs sm:grid-cols-3">
            <div>
              <dt class="text-muted-foreground">Source</dt>
              <dd class="mt-1 font-semibold">{diagnostics.health.apiKey.source}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Store</dt>
              <dd class="mt-1 font-semibold">{diagnostics.health.apiKey.storeKind}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Last API test</dt>
              <dd class="mt-1 font-semibold">
                {diagnostics.connectivity.checkedAt
  ? `${diagnostics.connectivity.status} · ${dateTimeLabel(diagnostics.connectivity.checkedAt)}`
  : 'Not checked'}
              </dd>
            </div>
          </dl>
          <p class="mt-3 text-xs leading-5 text-muted-foreground">
            Only source/status metadata is exposed. The credential value is neither fetched nor
            exportable.
          </p>
        </section>

        <section class="py-5" aria-labelledby="registry-diagnostic-heading">
          <h3 id="registry-diagnostic-heading" class="section-heading">Model registry</h3>
          {#if diagnostics.registry.length}
            <ul class="mt-3 divide-y divide-border border-y border-border">
              {#each diagnostics.registry as registry}
                <li class="grid gap-1 py-3 text-xs sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                  <span class="font-mono font-semibold">{registry.version}</span
                  ><Badge tone={registry.status === 'current' ? 'success' : 'warning'}
                    >{registry.status}</Badge
                  ><time class="text-muted-foreground" datetime={registry.verified_at}
                    >{dateTimeLabel(registry.verified_at)}</time
                  >
                </li>
              {/each}
            </ul>
          {:else}
            <p class="mt-3 text-sm text-warning">No registry versions are present.</p>
          {/if}
        </section>

        <section class="py-5" aria-labelledby="storage-diagnostic-heading">
          <h3 id="storage-diagnostic-heading" class="section-heading">Storage and filesystem</h3>
          <dl class="mt-4 grid gap-4 text-xs sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt class="text-muted-foreground">Configuration source</dt>
              <dd class="mt-1 font-semibold">{diagnostics.settings.storageSource}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Indexed media</dt>
              <dd class="mt-1 font-semibold">{byteSizeLabel(diagnostics.storage.indexedBytes)}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Verified files</dt>
              <dd class="mt-1 font-semibold">{diagnostics.storage.verifiedFiles}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Missing/deleted</dt>
              <dd class="mt-1 font-semibold">{diagnostics.storage.missingOrDeletedFiles}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Disk capacity</dt>
              <dd class="mt-1 font-semibold">
                {diagnostics.storage.capacityBytes === null
  ? 'Unavailable'
  : byteSizeLabel(diagnostics.storage.capacityBytes)}
              </dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Disk free</dt>
              <dd class="mt-1 font-semibold">
                {diagnostics.storage.freeBytes === null
  ? 'Unavailable'
  : byteSizeLabel(diagnostics.storage.freeBytes)}
              </dd>
            </div>
          </dl>
          <p class="mt-3 text-xs text-muted-foreground">
            Configured paths are deliberately redacted from this report.
          </p>
        </section>

        <section class="py-5" aria-labelledby="scheduler-heading">
          <div class="flex flex-wrap items-center gap-2">
            <h3 id="scheduler-heading" class="section-heading">Workers and retention scheduler</h3>
            <Badge tone={diagnostics.cleanup.lastError ? 'warning' : 'success'}
              >{diagnostics.cleanup.lastError ? 'degraded' : 'healthy'}</Badge
            >
          </div>
          <dl class="mt-4 grid gap-4 text-xs sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt class="text-muted-foreground">Cleanup worker</dt>
              <dd class="mt-1 font-semibold">
                {diagnostics.cleanup.scheduled ? 'Scheduled' : 'Not scheduled'}{diagnostics.cleanup.running ? ' · running now' : ''}
              </dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Last run</dt>
              <dd class="mt-1 font-semibold">
                {diagnostics.cleanup.lastRunAt ? dateTimeLabel(diagnostics.cleanup.lastRunAt) : 'Not yet run'}
              </dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Last error</dt>
              <dd class="mt-1 font-semibold">{diagnostics.cleanup.lastError ?? 'None'}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Normal polling</dt>
              <dd class="mt-1 font-semibold">{diagnostics.settings.polling.intervalMs / 1000}s</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Stale threshold</dt>
              <dd class="mt-1 font-semibold">
                {Math.round(diagnostics.settings.polling.staleAfterMs / 60_000)}m
              </dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Automatic downloads</dt>
              <dd class="mt-1 font-semibold">
                {diagnostics.settings.downloads.automatic ? 'Enabled' : 'Disabled'}
              </dd>
            </div>
          </dl>
          {#if Object.keys(diagnostics.cleanup.actions).length}
            <div class="mt-3 flex flex-wrap gap-2">
              {#each Object.entries(diagnostics.cleanup.actions) as [state, count]}
                <Badge tone="neutral">{state}: {count}</Badge>
              {/each}
            </div>
          {/if}
          <p class="mt-3 text-xs leading-5 text-muted-foreground">
            Scheduled cleanup naturally pauses while the application is closed and reconciles
            durable overdue work after restart.
          </p>
        </section>

        <section class="py-5" aria-labelledby="remote-diagnostic-heading">
          <div class="flex flex-wrap items-center gap-2">
            <h3 id="remote-diagnostic-heading" class="section-heading">
              Remote cleanup capability
            </h3>
            <Badge tone="neutral">Unavailable</Badge>
          </div>
          <p class="mt-2 text-sm leading-6 text-muted-foreground">
            {diagnostics.remoteCleanup.reason}
            Verified {diagnostics.remoteCleanup.verifiedAt}. No remote deletion schedule can be
            created.
          </p>
        </section>

        <section class="py-5" aria-labelledby="logging-diagnostic-heading">
          <div class="flex flex-wrap items-center gap-2">
            <h3 id="logging-diagnostic-heading" class="section-heading">Logging and rotation</h3>
            <Badge tone={diagnostics.logging.status === 'ok' ? 'success' : 'warning'}
              >{diagnostics.logging.status}</Badge
            >
          </div>
          <dl class="mt-4 grid gap-4 text-xs sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt class="text-muted-foreground">Log files</dt>
              <dd class="mt-1 font-semibold">
                {diagnostics.logging.files}
                · {byteSizeLabel(diagnostics.logging.bytes)}
              </dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Separate error stream</dt>
              <dd class="mt-1 font-semibold">
                {diagnostics.logging.separateErrorFile ? 'Enabled' : 'Disabled'}
              </dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Rotate at size</dt>
              <dd class="mt-1 font-semibold">
                {byteSizeLabel(diagnostics.logging.rotation.maxBytes)}
              </dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Rotate at age</dt>
              <dd class="mt-1 font-semibold">
                {Math.round(diagnostics.logging.rotation.maxAgeMs / 3_600_000)}h
              </dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Retention</dt>
              <dd class="mt-1 font-semibold">
                {Math.round(diagnostics.logging.rotation.retentionAgeMs / 86_400_000)}d ·
                {diagnostics.logging.rotation.maxRotatedFiles}
                files
              </dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Rotation error</dt>
              <dd class="mt-1 font-semibold">
                {diagnostics.logging.lastRotationError?.name ?? 'None'}
              </dd>
            </div>
          </dl>
          <p class="mt-3 text-xs text-muted-foreground">
            Logs are stored under the configured local logs directory; its absolute path is omitted
            from copied diagnostics.
          </p>
        </section>
      </div>

      <div class="mt-6 flex items-start gap-3 rounded bg-muted px-4 py-3">
        <AppIcon name="shield" size={18} class="mt-0.5 shrink-0 text-muted-foreground" />
        <p class="text-sm leading-6 text-muted-foreground">
          Diagnostic exports are designed to be safe to share, but review them before they leave the
          local machine.
        </p>
      </div>
    </section>
  </div>
</div>
