import { redirect } from 'next/navigation';
import { getUser, currentMembership } from '@/lib/db/queries';

/** Real session check. Cookie presence is not enough. */
export async function redirectSignedInUser(): Promise<void> {
  const user = await getUser();
  if (!user) return;
  const membership = await currentMembership(user.id);
  if (membership) redirect('/admin');
}
