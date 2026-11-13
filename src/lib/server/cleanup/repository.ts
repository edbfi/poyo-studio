import type { Database } from 'bun:sqlite';
import type { CleanupConsequence, LocalCleanupPolicy } from '../../features/cleanup/contracts';
import { packDurableJobEventPayload } from '../jobs/event-attention';
import { DatabaseRepository } from '../platform/repository';
import { cleanupHash, normalizeCleanupPolicy } from './policy';

export const LOCAL_CLEANUP_POLICY_ID = 'local-default';

export interface CleanupTargetRecord {
  targetKind: 'output' | 'managed-source';
  targetId: string;
  outputId: string | null;
  managedSourceId: string | null;
  jobId: string | null;
  jobIds: string[];
  mediaKind: 'image' | 'video';
  localPath: string;
  bytes: number;
  favorite: boolean;
  pinned: boolean;
  activeReference: boolean;
  createdAt: string;
  tags: string[];
}

export interface CleanupActionSnapshot extends CleanupTargetRecord {
  reasons: Array<'age' | 'storage-limit' | 'free-space'>;
  policyHash: string;
}

export interface CleanupClaim {
  actionId: string;
  targetId: string;
  actionKind: 'local_file' | 'local_metadata' | 'local_both';
  snapshot: CleanupActionSnapshot;
  owner: string;
  token: string;
  attempt: number;
}
export type OutputCleanupActionKind = Extract<
  CleanupClaim['actionKind'],
  'local_file' | 'local_metadata' | 'local_both'
>;

type OutputRow = {
  id: string;
  job_id: string;
  media_kind: 'image' | 'video';
  local_path: string;
  byte_size: number | null;
  favorite: number;
  pinned: number;
  created_at: string;
  tags_json: string;
};

type SourceRow = {
  id: string;
  media_kind: 'image' | 'video';
  relative_path: string;
  byte_size: number;
  created_at: string;
  favorite: number;
  pinned: number;
  active_reference: number;
  job_ids_json: string;
  tags_json: string;
};

type ActionRow = {
  id: string;
  target_id: string;
  action_kind: CleanupClaim['actionKind'];
  safe_result_json: string;
};
type OutputJobLifecycleRow = {
  local_phase: string;
  remote_status_raw: string | null;
  remote_status: string;
  failure_domain: string;
  progress: number | null;
  attention_code: string | null;
};

function actionKind(consequence: CleanupConsequence): CleanupClaim['actionKind'] {
  return consequence === 'file'
    ? 'local_file'
    : consequence === 'metadata'
      ? 'local_metadata'
      : 'local_both';
}

function parseStrings(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseSnapshot(value: string): CleanupActionSnapshot {
  const snapshot = (JSON.parse(value) as { preview: CleanupActionSnapshot }).preview;
  if (snapshot.targetKind !== 'output' && snapshot.targetKind !== 'managed-source') {
    throw new Error('Cleanup action snapshot has no valid target.');
  }
  return snapshot;
}

export class CleanupRepository extends DatabaseRepository {
  constructor(
    database: Database,
    private readonly now: () => Date = () => new Date()
  ) {
    super(database);
  }

  getPolicy(): LocalCleanupPolicy | null {
    return this.readPolicy(false);
  }

  getEnabledPolicy(): LocalCleanupPolicy | null {
    return this.readPolicy(true);
  }

  private readPolicy(enabledOnly: boolean): LocalCleanupPolicy | null {
    const row = this.database
      .query<{ policy_json: string }, [string]>(
        `SELECT policy_json FROM cleanup_policies WHERE id=?${enabledOnly ? ' AND enabled=1' : ''}`
      )
      .get(LOCAL_CLEANUP_POLICY_ID);
    return row ? normalizeCleanupPolicy(JSON.parse(row.policy_json)) : null;
  }

  savePolicy(policy: LocalCleanupPolicy): LocalCleanupPolicy {
    const now = this.now().toISOString();
    this.database
      .query(
        `INSERT INTO cleanup_policies(id,policy_version,enabled,policy_json,created_at,updated_at)
         VALUES (?,1,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET policy_version=policy_version+1,enabled=excluded.enabled,
           policy_json=excluded.policy_json,updated_at=excluded.updated_at`
      )
      .run(
        LOCAL_CLEANUP_POLICY_ID,
        policy.mode === 'never' ? 0 : 1,
        JSON.stringify(policy),
        now,
        now
      );
    return policy;
  }

  listOutputs(): CleanupTargetRecord[] {
    return this.database
      .query<OutputRow, []>(
        `SELECT o.id,o.job_id,o.media_kind,o.local_path,o.byte_size,o.favorite,o.pinned,o.created_at,
          COALESCE((SELECT json_group_array(t.normalized_name) FROM job_tags jt JOIN tags t ON t.id=jt.tag_id WHERE jt.job_id=o.job_id),'[]') tags_json
         FROM job_outputs o
         WHERE o.download_state='verified' AND o.local_path IS NOT NULL
         ORDER BY o.created_at ASC,o.id ASC`
      )
      .all()
      .map((row) => ({
        targetKind: 'output' as const,
        targetId: row.id,
        outputId: row.id,
        managedSourceId: null,
        jobId: row.job_id,
        jobIds: [row.job_id],
        mediaKind: row.media_kind,
        localPath: row.local_path,
        bytes: row.byte_size ?? 0,
        favorite: row.favorite === 1,
        pinned: row.pinned === 1,
        activeReference: false,
        createdAt: row.created_at,
        tags: parseStrings(row.tags_json)
      }));
  }

  listTargets(consequence: CleanupConsequence): CleanupTargetRecord[] {
    const outputs = this.listOutputs();
    const sources = this.database
      .query<SourceRow, [string]>(
        `SELECT ms.id,ms.media_kind,ms.relative_path,ms.byte_size,ms.created_at,
          EXISTS(SELECT 1 FROM job_inputs ji JOIN job_outputs o ON o.job_id=ji.job_id WHERE ji.managed_source_id=ms.id AND o.favorite=1) favorite,
          EXISTS(SELECT 1 FROM job_inputs ji JOIN job_outputs o ON o.job_id=ji.job_id WHERE ji.managed_source_id=ms.id AND o.pinned=1) pinned,
          (EXISTS(SELECT 1 FROM job_inputs ji JOIN jobs j ON j.id=ji.job_id WHERE ji.managed_source_id=ms.id AND j.local_phase!='complete') OR EXISTS(SELECT 1 FROM job_inputs ji JOIN generation_retry_reservations q ON q.parent_id=ji.job_id JOIN generation_retry_roots r ON r.root_id=q.root_id WHERE ji.managed_source_id=ms.id AND ((q.state IN ('pending','refreshing') AND r.state='running') OR (q.lease_token IS NOT NULL AND q.lease_expires_at>?)))) active_reference,
          COALESCE((SELECT json_group_array(job_id) FROM (SELECT DISTINCT ji.job_id FROM job_inputs ji WHERE ji.managed_source_id=ms.id ORDER BY ji.job_id)),'[]') job_ids_json,
          COALESCE((SELECT json_group_array(normalized_name) FROM (SELECT DISTINCT t.normalized_name FROM job_inputs ji JOIN job_tags jt ON jt.job_id=ji.job_id JOIN tags t ON t.id=jt.tag_id WHERE ji.managed_source_id=ms.id ORDER BY t.normalized_name)),'[]') tags_json
         FROM managed_sources ms WHERE ms.availability='available'
         ORDER BY ms.created_at,ms.id`
      )
      .all(this.now().toISOString())
      .map((row) => {
        const jobIds = parseStrings(row.job_ids_json);
        return {
          targetKind: 'managed-source' as const,
          targetId: row.id,
          outputId: null,
          managedSourceId: row.id,
          jobId: jobIds[0] ?? null,
          jobIds,
          mediaKind: row.media_kind,
          localPath: row.relative_path,
          bytes: row.byte_size,
          favorite: row.favorite === 1,
          pinned: row.pinned === 1,
          activeReference: row.active_reference === 1 || consequence !== 'file',
          createdAt: row.created_at,
          tags: parseStrings(row.tags_json)
        };
      });
    return [...outputs, ...sources].toSorted((a, b) =>
      a.createdAt === b.createdAt
        ? a.targetId.localeCompare(b.targetId)
        : a.createdAt.localeCompare(b.createdAt)
    );
  }

  persistPreview(
    token: string,
    policyHash: string,
    consequence: CleanupConsequence,
    snapshots: CleanupActionSnapshot[]
  ): void {
    const now = this.now().toISOString();
    const candidateHash = cleanupHash(
      snapshots.map(({ targetKind, targetId, localPath, bytes, reasons }) => ({
        targetKind,
        targetId,
        localPath,
        bytes,
        reasons
      }))
    );
    this.transaction(() => {
      this.database
        .query(
          `INSERT INTO cleanup_previews(token,policy_id,action_kind,policy_hash,candidate_hash,candidate_count,total_bytes,created_at)
           VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(token) DO NOTHING`
        )
        .run(
          token,
          LOCAL_CLEANUP_POLICY_ID,
          actionKind(consequence),
          policyHash,
          candidateHash,
          snapshots.length,
          snapshots.reduce((total, entry) => total + entry.bytes, 0),
          now
        );
      for (const snapshot of snapshots) {
        const id = `cleanup_${cleanupHash([token, snapshot.targetKind, snapshot.targetId]).slice(0, 32)}`;
        this.database
          .query(
            `INSERT INTO cleanup_actions(id,policy_id,action_kind,target_id,preview_version,state,due_at,safe_result_json,created_at)
             VALUES (?,?,?,?,?,'previewed',NULL,?,?) ON CONFLICT(id) DO NOTHING`
          )
          .run(
            id,
            LOCAL_CLEANUP_POLICY_ID,
            actionKind(consequence),
            snapshot.targetId,
            token,
            JSON.stringify({ preview: snapshot }),
            now
          );
      }
    });
  }

  hasPendingActions(policyHash: string, consequence: CleanupConsequence): boolean {
    return Boolean(
      this.database
        .query<{ present: number }, [string, CleanupClaim['actionKind']]>(
          `SELECT 1 present FROM cleanup_actions a
           JOIN cleanup_previews p ON p.token=a.preview_version
           WHERE p.policy_hash=? AND a.action_kind=? AND a.state IN ('scheduled','executing')
           LIMIT 1`
        )
        .get(policyHash, actionKind(consequence))
    );
  }

  schedulePreview(token: string): number {
    return this.transaction(() => {
      const preview = this.database
        .query<
          { policy_hash: string; candidate_count: number; applied_at: string | null },
          [string]
        >('SELECT policy_hash,candidate_count,applied_at FROM cleanup_previews WHERE token=?')
        .get(token);
      if (!preview) throw new Error('Cleanup preview was not found.');
      const policy = this.getPolicy();
      if (!policy || cleanupHash(policy) !== preview.policy_hash) {
        throw new Error('Cleanup preview is stale because the policy changed.');
      }
      const actions = this.database
        .query<ActionRow, [string]>(
          'SELECT id,target_id,action_kind,safe_result_json FROM cleanup_actions WHERE preview_version=? ORDER BY id'
        )
        .all(token);
      if (actions.length !== preview.candidate_count)
        throw new Error('Cleanup preview is incomplete.');
      for (const action of actions) {
        const stored = parseSnapshot(action.safe_result_json);
        const current = this.listTargets(policy.consequence).find(
          (target) =>
            target.targetKind === stored.targetKind && target.targetId === action.target_id
        );
        if (!current) throw new Error('A cleanup candidate is no longer available.');
        if (
          current.localPath !== stored.localPath ||
          current.bytes !== stored.bytes ||
          current.activeReference ||
          (policy.exclusions.favorites && current.favorite) ||
          (policy.exclusions.pinned && current.pinned) ||
          current.tags.some((tag) => policy.exclusions.tags.includes(tag))
        ) {
          throw new Error('A cleanup candidate changed after preview.');
        }
      }
      const now = this.now().toISOString();
      if (preview.applied_at) {
        return this.database
          .query(
            `UPDATE cleanup_actions SET state='scheduled',due_at=?,executed_at=NULL
             WHERE preview_version=? AND state='cancelled'`
          )
          .run(now, token).changes;
      }
      this.database
        .query(
          `UPDATE cleanup_actions SET state='scheduled',due_at=?
           WHERE preview_version=? AND state='previewed'`
        )
        .run(now, token);
      this.database.query('UPDATE cleanup_previews SET applied_at=? WHERE token=?').run(now, token);
      return actions.length;
    });
  }

  reconcileExpiredClaims(): number {
    const now = this.now().toISOString();
    return this.database
      .query(
        `UPDATE cleanup_actions SET state='scheduled'
         WHERE state='executing' AND NOT EXISTS (
           SELECT 1 FROM work_claims c WHERE c.work_type='cleanup' AND c.work_id=cleanup_actions.id AND c.expires_at>?
         )`
      )
      .run(now).changes;
  }

  claimNext(owner: string, leaseMs: number): CleanupClaim | null {
    return this.transaction(() => {
      const now = this.now().toISOString();
      let action: ActionRow | null;
      let snapshot: CleanupActionSnapshot;
      while (true) {
        action = this.database
          .query<ActionRow, [string]>(
            `SELECT id,target_id,action_kind,safe_result_json FROM cleanup_actions
             WHERE state='scheduled' AND due_at IS NOT NULL AND due_at<=?
             ORDER BY due_at,id LIMIT 1`
          )
          .get(now);
        if (!action) return null;
        const candidateAction = action;
        snapshot = parseSnapshot(candidateAction.safe_result_json);
        const policy = this.getEnabledPolicy();
        const current = policy
          ? this.listTargets(policy.consequence).find(
              (target) =>
                target.targetKind === snapshot.targetKind &&
                target.targetId === candidateAction.target_id
            )
          : undefined;
        const stale =
          !policy ||
          cleanupHash(policy) !== snapshot.policyHash ||
          !current ||
          current.localPath !== snapshot.localPath ||
          current.bytes !== snapshot.bytes ||
          current.activeReference ||
          (policy.exclusions.favorites && current.favorite) ||
          (policy.exclusions.pinned && current.pinned) ||
          current.tags.some((tag) => policy.exclusions.tags.includes(tag));
        if (!stale) break;
        this.database
          .query(
            `UPDATE cleanup_actions SET state='cancelled',safe_result_json=?,executed_at=?
             WHERE id=? AND state='scheduled'`
          )
          .run(
            JSON.stringify({ preview: snapshot, reconciliation: { status: 'candidate-changed' } }),
            now,
            candidateAction.id
          );
        this.database
          .query("DELETE FROM work_claims WHERE work_type='cleanup' AND work_id=?")
          .run(candidateAction.id);
      }
      if (!action) return null;
      const existing = this.database
        .query<{ expires_at: string; attempt: number }, [string]>(
          "SELECT expires_at,attempt FROM work_claims WHERE work_type='cleanup' AND work_id=?"
        )
        .get(action.id);
      if (existing && existing.expires_at > now) return null;
      const token = crypto.randomUUID();
      const attempt = (existing?.attempt ?? 0) + 1;
      const expires = new Date(this.now().getTime() + leaseMs).toISOString();
      if (existing)
        this.database
          .query(
            `UPDATE work_claims SET owner=?,token=?,acquired_at=?,expires_at=?,attempt=?
             WHERE work_type='cleanup' AND work_id=? AND expires_at<=?`
          )
          .run(owner, token, now, expires, attempt, action.id, now);
      else
        this.database
          .query(
            `INSERT INTO work_claims(work_type,work_id,owner,token,acquired_at,expires_at,attempt)
             VALUES ('cleanup',?,?,?,?,?,?)`
          )
          .run(action.id, owner, token, now, expires, attempt);
      const claimed = this.database
        .query<{ token: string }, [string, string]>(
          "SELECT token FROM work_claims WHERE work_type='cleanup' AND work_id=? AND owner=?"
        )
        .get(action.id, owner);
      if (claimed?.token !== token) return null;
      if (
        this.database
          .query("UPDATE cleanup_actions SET state='executing' WHERE id=? AND state='scheduled'")
          .run(action.id).changes !== 1
      ) {
        this.database
          .query("DELETE FROM work_claims WHERE work_type='cleanup' AND work_id=? AND token=?")
          .run(action.id, token);
        return null;
      }
      this.database
        .query(
          `INSERT INTO cleanup_attempts(action_id,attempt,status,started_at)
           VALUES (?,?,'started',?)`
        )
        .run(action.id, attempt, now);
      return {
        actionId: action.id,
        targetId: action.target_id,
        actionKind: action.action_kind,
        snapshot,
        owner,
        token,
        attempt
      };
    });
  }

  complete(claim: CleanupClaim, result: unknown): boolean {
    return this.finish(claim, 'complete', result);
  }

  fail(claim: CleanupClaim, result: unknown): boolean {
    return this.finish(claim, 'failed', result);
  }

  private finish(claim: CleanupClaim, state: 'complete' | 'failed', result: unknown): boolean {
    return this.transaction(() => {
      const held = this.database
        .query<{ token: string }, [string, string, string]>(
          "SELECT token FROM work_claims WHERE work_type='cleanup' AND work_id=? AND owner=? AND token=?"
        )
        .get(claim.actionId, claim.owner, claim.token);
      if (!held) return false;
      const now = this.now().toISOString();
      this.database
        .query(
          'UPDATE cleanup_attempts SET status=?,safe_result_json=?,completed_at=? WHERE action_id=? AND attempt=?'
        )
        .run(state, JSON.stringify(result), now, claim.actionId, claim.attempt);
      this.database
        .query('UPDATE cleanup_actions SET state=?,safe_result_json=?,executed_at=? WHERE id=?')
        .run(
          state,
          JSON.stringify({ preview: claim.snapshot, execution: result }),
          state === 'complete' ? now : null,
          claim.actionId
        );
      this.database
        .query(
          "DELETE FROM work_claims WHERE work_type='cleanup' AND work_id=? AND owner=? AND token=?"
        )
        .run(claim.actionId, claim.owner, claim.token);
      return true;
    });
  }

  applyOutputConsequence(
    outputId: string,
    jobId: string,
    actionKind: OutputCleanupActionKind
  ): boolean {
    return this.transaction(() => {
      const lifecycle = this.database
        .query<OutputJobLifecycleRow, [string, string]>(
          `SELECT j.local_phase,j.remote_status_raw,j.remote_status,j.failure_domain,j.progress,
            j.attention_code
           FROM job_outputs o JOIN jobs j ON j.id=o.job_id
           WHERE o.id=? AND o.job_id=?`
        )
        .get(outputId, jobId);
      if (!lifecycle) return false;

      const changed =
        actionKind === 'local_file'
          ? this.database
              .query(
                `UPDATE job_outputs SET local_path=NULL,download_state='deleted',verified_at=NULL,
                  deleted_at=? WHERE id=? AND job_id=? AND local_path IS NOT NULL
                  AND download_state='verified'`
              )
              .run(this.now().toISOString(), outputId, jobId).changes === 1
          : this.database
              .query('DELETE FROM job_outputs WHERE id=? AND job_id=?')
              .run(outputId, jobId).changes === 1;
      if (!changed) return false;

      this.database
        .query(
          `INSERT INTO job_events(job_id,event_type,local_phase,remote_status_raw,remote_status,
            failure_domain,progress,safe_payload_json,observed_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(
          jobId,
          `output.${actionKind}_removed`,
          lifecycle.local_phase,
          lifecycle.remote_status_raw,
          lifecycle.remote_status,
          lifecycle.failure_domain,
          lifecycle.progress,
          JSON.stringify(packDurableJobEventPayload({ outputId }, lifecycle.attention_code)),
          this.now().toISOString()
        );
      return true;
    });
  }

  markManagedSourceFileRemoved(sourceId: string, availability: 'missing' | 'deleted'): boolean {
    const now = this.now().toISOString();
    return this.transaction(() => {
      const changed =
        this.database
          .query(
            `UPDATE managed_sources SET availability=?,last_verified_at=NULL,
              missing_at=CASE WHEN ?='missing' THEN COALESCE(missing_at,?) ELSE missing_at END,
              deleted_at=CASE WHEN ?='deleted' THEN ? ELSE deleted_at END
             WHERE id=? AND availability='available'`
          )
          .run(availability, availability, now, availability, now, sourceId).changes === 1;
      if (changed) {
        this.database
          .query('UPDATE job_inputs SET availability=? WHERE managed_source_id=?')
          .run(availability, sourceId);
      }
      return changed;
    });
  }

  actionCounts(): Record<string, number> {
    return Object.fromEntries(
      this.database
        .query<{ state: string; count: number }, []>(
          'SELECT state,COUNT(*) count FROM cleanup_actions GROUP BY state ORDER BY state'
        )
        .all()
        .map((row) => [row.state, row.count])
    );
  }
}
