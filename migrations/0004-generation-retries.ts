import type { Migration } from './types';

export const generationRetriesMigration: Migration = {
  version: 4,
  name: 'durable opt-in generation retry chains',
  sql: `
ALTER TABLE jobs ADD COLUMN auto_root_id TEXT REFERENCES jobs(id);
ALTER TABLE jobs ADD COLUMN auto_parent_id TEXT REFERENCES jobs(id);
ALTER TABLE jobs ADD COLUMN auto_ordinal INTEGER NOT NULL DEFAULT 0 CHECK(auto_ordinal BETWEEN 0 AND 5);
ALTER TABLE jobs ADD COLUMN local_outcome TEXT CHECK(local_outcome IN ('generation','stopped-before-dispatch'));
ALTER TABLE jobs ADD COLUMN settled_at TEXT;
ALTER TABLE jobs ADD COLUMN retry_eligible_rejection INTEGER NOT NULL DEFAULT 0 CHECK(retry_eligible_rejection IN (0,1));
ALTER TABLE jobs ADD COLUMN terminal_ack_pending INTEGER NOT NULL DEFAULT 0 CHECK(terminal_ack_pending IN (0,1));
ALTER TABLE jobs ADD COLUMN output_observed INTEGER NOT NULL DEFAULT 0 CHECK(output_observed IN (0,1));
UPDATE jobs SET output_observed=1 WHERE EXISTS(SELECT 1 FROM job_outputs WHERE job_id=jobs.id);
CREATE TABLE generation_retry_roots (
  root_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  max_retries INTEGER NOT NULL CHECK(max_retries BETWEEN 1 AND 5),
  state TEXT NOT NULL CHECK(state IN ('running','stopped','blocked','exhausted','succeeded','needs_attention')),
  reason TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE generation_retry_reservations (
  parent_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  root_id TEXT NOT NULL REFERENCES generation_retry_roots(root_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 5),
  action_id TEXT NOT NULL UNIQUE,
  due_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','refreshing','created','blocked','stopped')),
  child_id TEXT UNIQUE REFERENCES jobs(id),
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  fence INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(root_id,ordinal)
);
CREATE INDEX idx_generation_retry_due ON generation_retry_reservations(state,due_at,lease_expires_at);
CREATE INDEX idx_jobs_auto_root ON jobs(auto_root_id,auto_ordinal);
UPDATE jobs SET settled_at=(SELECT observed_at FROM job_events e WHERE e.job_id=jobs.id AND e.event_type='status.observed' AND e.remote_status IN ('finished','failed') ORDER BY event_id LIMIT 1)
 WHERE remote_status IN ('finished','failed');
`
};
