'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { clientSignIn } from '@/lib/auth/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * The preferred email path. Opening the link proves control of the mailbox, so
 * it signs in and verifies the address in one step — no password to plant, leak
 * or reset, and no window where an unproven address holds an account.
 */
export function MagicLinkForm({
  mode,
  redirectTo = '/welcome',
}: {
  mode: 'signin' | 'signup';
  redirectTo?: string;
}) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (sent) {
    return (
      <div
        style={{
          border: '1px solid #bbf7d0',
          background: '#f0fdf4',
          borderRadius: 12,
          padding: 16,
          fontSize: 14,
          color: '#14532d',
          lineHeight: 1.6,
        }}
      >
        <strong>Check {email}.</strong> The link signs you in and expires shortly. Nothing happens
        until you open it.
        <button
          type="button"
          onClick={() => {
            setSent(false);
            setError(null);
          }}
          style={{
            display: 'block',
            marginTop: 8,
            background: 'none',
            border: 'none',
            padding: 0,
            color: '#166534',
            textDecoration: 'underline',
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          Use a different address
        </button>
      </div>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setPending(true);
        const res = await clientSignIn.magicLink({ email, callbackURL: redirectTo });
        setPending(false);
        if (res?.error) setError(res.error.message ?? 'Could not send the link.');
        else setSent(true);
      }}
    >
      <div>
        <Label htmlFor="magic-email" className="text-sm font-medium">
          Email
        </Label>
        <Input
          id="magic-email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          className="mt-1"
        />
      </div>
      <Button type="submit" className="w-full" disabled={pending || email.length < 3}>
        {pending && <Loader2 className="animate-spin h-4 w-4" />}
        {mode === 'signin' ? 'Email me a sign-in link' : 'Email me a link to start'}
      </Button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
