import { Suspense } from 'react';
import { Login } from '../login';
import { googleAuthEnabled } from '@/lib/auth/auth';

// Evaluated per request: the Google credentials are runtime env vars, so a
// prerendered page would freeze whatever the flag was at BUILD time — which is
// exactly how the button went missing after the credentials were added.
export const dynamic = 'force-dynamic';

export default function SignUpPage() {
  return (
    <Suspense>
      <Login mode="signup" googleEnabled={googleAuthEnabled} />
    </Suspense>
  );
}
