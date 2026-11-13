import { DOCUMENTED_POLICY_REJECTION_MESSAGE } from '../poyo/provider-diagnostic';
import type { PoyoStatusResult } from '../poyo/types';
import type { JobRecord } from './types';

// Official status.md / error-codes.md failure example. No substring matching, no HTTP replay.
export function isVerifiedPollRejection(job: JobRecord, status: PoyoStatusResult): boolean {
  return (
    ['text-to-image', 'image-to-image', 'image-edit'].includes(job.workflow) &&
    job.poyoTaskId !== null &&
    status.taskId === job.poyoTaskId &&
    !job.terminalAckPending &&
    !job.outputObserved &&
    job.remoteStatus !== 'failed' &&
    job.remoteStatus !== 'finished' &&
    status.status === 'failed' &&
    status.statusRaw === 'failed' &&
    status.errorMessage === DOCUMENTED_POLICY_REJECTION_MESSAGE &&
    status.creditsAmount === 0 &&
    status.filesExplicit === true &&
    status.files.length === 0
  );
}
