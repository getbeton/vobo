import { Suspense } from 'react';
import { Login } from '../login';
import { googleAuthEnabled } from '@/lib/auth/auth';

export default function SignInPage() {
  return (
    <Suspense>
      <Login mode="signin" googleEnabled={googleAuthEnabled} />
    </Suspense>
  );
}
