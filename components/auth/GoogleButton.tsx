'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { clientSignIn } from '@/lib/auth/client';
import { Button } from '@/components/ui/button';

/**
 * Google sign-in. Rendered only where the deployment has a Google OAuth client
 * configured — a self-hosted install without one never sees a dead button.
 */
export function GoogleButton({ redirectTo = '/welcome' }: { redirectTo?: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={pending}
        onClick={async () => {
          setError(null);
          setPending(true);
          const res = await clientSignIn.social({ provider: 'google', callbackURL: redirectTo });
          // On success the browser navigates away; only failures return here.
          if (res?.error) {
            setError(res.error.message ?? 'Google sign-in failed.');
            setPending(false);
          }
        }}
      >
        {pending ? (
          <Loader2 className="animate-spin h-4 w-4" />
        ) : (
          <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="#4285F4"
              d="M23.06 12.25c0-.85-.08-1.67-.22-2.45H12v4.63h6.2a5.3 5.3 0 0 1-2.3 3.48v2.89h3.72c2.18-2 3.44-4.96 3.44-8.55Z"
            />
            <path
              fill="#34A853"
              d="M12 24c3.11 0 5.72-1.03 7.62-2.8l-3.72-2.89c-1.03.69-2.35 1.1-3.9 1.1-3 0-5.540-2.03-6.45-4.75H1.7v2.98A11.5 11.5 0 0 0 12 24Z"
            />
            <path
              fill="#FBBC05"
              d="M5.55 14.66a6.9 6.9 0 0 1 0-4.4V7.28H1.7a11.5 11.5 0 0 0 0 10.36l3.85-2.98Z"
            />
            <path
              fill="#EA4335"
              d="M12 4.75c1.69 0 3.2.58 4.4 1.72l3.3-3.3C17.71 1.2 15.1 0 12 0 7.47 0 3.55 2.6 1.7 6.38l3.85 2.98C6.46 6.78 9 4.75 12 4.75Z"
            />
          </svg>
        )}
        Continue with Google
      </Button>
      {error && <p className="text-sm text-red-600 text-center">{error}</p>}
    </div>
  );
}
