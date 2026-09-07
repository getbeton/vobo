import { Suspense } from 'react';
import { Login } from '../login';
import { googleAuthEnabled } from '@/lib/auth/auth';
import { redirectSignedInUser } from '@/lib/auth/redirect-signed-in';

// Evaluated per request: the Google credentials are runtime env vars, so a
// prerendered page would freeze whatever the flag was at BUILD time — which is
// exactly how the button went missing after the credentials were added.
export const dynamic = 'force-dynamic';

export default async function SignUpPage() {
  await redirectSignedInUser();
  return (
    <Suspense>
      <Login mode="signup" googleEnabled={googleAuthEnabled} />
    </Suspense>
  );
}
