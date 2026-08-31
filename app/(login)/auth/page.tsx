import { Suspense } from 'react';
import { Login } from '../login';
import { googleAuthEnabled } from '@/lib/auth/auth';

// Evaluated per request: Google credentials are runtime env vars, so a
// prerendered page would freeze whatever the flag was at BUILD time.
export const dynamic = 'force-dynamic';

export default function AuthPage() {
  return (
    <Suspense>
      <Login mode="signup" googleEnabled={googleAuthEnabled} />
    </Suspense>
  );
}
