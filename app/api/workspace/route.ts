import { getWorkspaceForUser } from '@/lib/db/queries';

export async function GET() {
  const workspace = await getWorkspaceForUser();
  return Response.json(workspace);
}
