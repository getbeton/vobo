import { asc, eq } from 'drizzle-orm';
import {
  artifactVersions,
  events,
  projects,
  reviewRequests,
} from '@/lib/db/schema';
import { DbOrTx } from './eventlog';
import { MARKDOWN_BODY_PATH } from './commitment';
import { ApiProblem } from './requests';
import {
  AUDIT_BUNDLE_FORMAT,
  AuditBundle,
  AuditBundleArtifact,
} from './audit-bundle';

export async function buildRequestAuditBundle(
  dbh: DbOrTx,
  requestId: string
): Promise<AuditBundle> {
  const request = await dbh.query.reviewRequests.findFirst({
    where: eq(reviewRequests.id, requestId),
  });
  if (!request) throw new ApiProblem(404, 'request_not_found', 'Request not found');

  const project = await dbh.query.projects.findFirst({
    where: eq(projects.id, request.projectId),
    columns: { workspaceId: true },
  });
  if (!project) throw new ApiProblem(500, 'project_missing', 'Project missing');

  const versionRows = await dbh
    .select()
    .from(artifactVersions)
    .where(eq(artifactVersions.requestId, requestId))
    .orderBy(asc(artifactVersions.versionNumber));

  const eventRows = await dbh
    .select()
    .from(events)
    .where(eq(events.requestId, requestId))
    .orderBy(asc(events.seq));

  const artifacts: AuditBundleArtifact[] = versionRows.map((v) => {
    const erased = v.commitmentKey === null || v.keyDestroyedAt !== null;
    const purged = v.contentPurgedAt !== null;
    const artifact: AuditBundleArtifact = {
      id: v.id,
      version_number: v.versionNumber,
      file_path: MARKDOWN_BODY_PATH,
      content: purged || erased ? null : v.contentMd,
      commitment: v.contentHash,
    };
    if (!erased && v.commitmentKey) {
      artifact.commitment_key = v.commitmentKey;
    }
    return artifact;
  });

  return {
    format: AUDIT_BUNDLE_FORMAT,
    exported_at: new Date().toISOString(),
    workspace_id: project.workspaceId,
    requests: [
      {
        id: request.id,
        customer_request_id: request.customerRequestId,
        artifacts,
        events: eventRows.map((e) => ({
          seq: e.seq,
          type: e.type,
          payload: e.payload,
          prev_hash: e.prevHash,
          hash: e.hash,
          created_at: e.createdAt.toISOString(),
        })),
      },
    ],
  };
}
