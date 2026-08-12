import { Suspense } from 'react';
import { Login } from '../login';
import { googleAuthEnabled } from '@/lib/auth/auth';

export default function SignUpPage() {
  return (
    <Suspense>
      <Login mode="signup" googleEnabled={googleAuthEnabled} />
    </Suspense>
  );
}
