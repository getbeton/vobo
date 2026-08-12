'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { clientSignIn } from '@/lib/auth/client';

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
        <label
          htmlFor="magic-email"
          className="block text-sm font-medium text-gray-700"
        >
          Email
        </label>
        <input
          id="magic-email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          className="mt-1 appearance-none rounded-full relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 focus:outline-none focus:ring-orange-500 focus:border-orange-500 focus:z-10 sm:text-sm"
        />
      </div>
      <button
        type="submit"
        disabled={pending || email.length < 3}
        className="w-full flex justify-center items-center gap-2 py-2 px-4 border border-transparent rounded-full shadow-sm text-sm font-medium text-white bg-orange-600 hover:bg-orange-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-orange-500 disabled:opacity-60"
      >
        {pending && <Loader2 className="animate-spin h-4 w-4" />}
        {mode === 'signin' ? 'Email me a sign-in link' : 'Email me a link to start'}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
