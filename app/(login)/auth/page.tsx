import { Suspense } from 'react';
import { Login } from '../login';
import { googleAuthEnabled } from '@/lib/auth/auth';
import { redirectSignedInUser } from '@/lib/auth/redirect-signed-in';

// Evaluated per request: Google credentials are runtime env vars, so a
// prerendered page would freeze whatever the flag was at BUILD time.
export const dynamic = 'force-dynamic';

export default async function AuthPage() {
  await redirectSignedInUser();
  return (
    <Suspense>
      <Login mode="signin" googleEnabled={googleAuthEnabled} />
    </Suspense>
  );
}
