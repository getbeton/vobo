import { redirect } from 'next/navigation';
import { getUser } from '@/lib/db/queries';
import { ensurePersonalWorkspace } from '@/lib/auth/bootstrap';

/**
 * Landing point for social sign-in. BetterAuth creates the user and session on
 * the OAuth callback but knows nothing about workspaces, so this is where a
 * first-time Google user gets one before any workspace-scoped page runs.
 */
export async function GET() {
  const user = await getUser();
  if (!user) redirect('/sign-in');
  await ensurePersonalWorkspace(user.id, user.email);
  redirect('/queue');
}
