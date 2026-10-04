<script lang="ts">
import Badge from '#lib/components/ui/Badge.svelte';
import { statusLabel, statusTone } from '#lib/features/library/presentation.js';

interface Props {
  localPhase: string;
  remoteStatus: string;
  attentionCode?: string | null;
}

let { localPhase, remoteStatus, attentionCode = null }: Props = $props();
</script>

<Badge tone={statusTone(localPhase, remoteStatus, attentionCode)}>
  {statusLabel(localPhase, remoteStatus, attentionCode)}
</Badge>
