import { createHmac } from 'crypto';

export type WorkspacePlan =
  | 'community'
  | 'cloud_free'
  | 'cloud_paid'
  | 'enterprise'
  | 'self_host';

/**
 * Structural, not a flag (ARD §33.2). A boolean column that an operator could
 * flip is not enough for this guarantee.
 */
export function canEnterTraining(plan: WorkspacePlan): boolean {
  switch (plan) {
    case 'cloud_free':
    case 'cloud_paid':
      return true;
    case 'community':
    case 'enterprise':
    case 'self_host':
      return false;
  }
}

/** HMAC of the reviewer id with the workspace id as key. Raw user ids never leave. */
export function pseudonymiseReviewer(workspaceId: number, userId: string): string {
  return createHmac('sha256', `vobo-ws-${workspaceId}`).update(userId).digest('hex');
}
