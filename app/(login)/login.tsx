'use client';

import { useActionState, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';
import { signIn, signUp } from './actions';
import { ActionState } from '@/lib/auth/middleware';
import { GoogleButton } from '@/components/auth/GoogleButton';
import { MagicLinkForm } from '@/components/auth/MagicLinkForm';
import { Logo } from '@/components/shell/Logo';
import { safeInternalPath } from '@/lib/auth/paths';

const POST_AUTH = '/welcome';

const VALUE_PROPS: Array<{ title: string; body: string }> = [
  {
    title: 'Anchored corrections',
    body: 'A finding is a span, a cell, or a region — not a thread under the artifact. Regenerations re-match it.',
  },
  {
    title: 'Signed decisions',
    body: 'Accept or reject against criteria. Your pipeline gates on a hash-sealed verdict, not a chat message.',
  },
  {
    title: 'One endpoint, any producer',
    body: 'REST, MCP, or a webhook. What produced the artifact is not Vobo’s business.',
  },
];

/**
 * Combined auth screen, ported from data-atlas `/auth`: one page for sign-in
 * and sign-up, value column on large screens, methods above email.
 */
export function Login({
  mode: initialMode = 'signin',
  googleEnabled = false,
}: {
  mode?: 'signin' | 'signup';
  googleEnabled?: boolean;
}) {
  const searchParams = useSearchParams();
  const redirect = safeInternalPath(searchParams.get('redirect'));
  const inviteId = searchParams.get('inviteId');
  const [mode, setMode] = useState<'signin' | 'signup'>(initialMode);
  const [showPassword, setShowPassword] = useState(false);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    mode === 'signin' ? signIn : signUp,
    { error: '' }
  );
  const afterAuth = redirect || POST_AUTH;

  return (
    <main className="grid min-h-dvh grid-cols-1 lg:grid-cols-2">
      <section className="hidden flex-col justify-between bg-slate-950 px-8 py-12 text-white lg:flex xl:px-14">
        <a href="https://vobo.dev" className="text-white" aria-label="Vobo">
          <Logo height={24} />
        </a>
        <div className="max-w-md">
          <h2 className="text-3xl font-bold leading-tight tracking-tight xl:text-4xl">
            Human redline for AI output.
          </h2>
          <ul className="mt-8 grid gap-6">
            {VALUE_PROPS.map((v) => (
              <li key={v.title}>
                <p className="text-base font-semibold">{v.title}</p>
                <p className="mt-1 text-sm leading-relaxed text-white/70">{v.body}</p>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs uppercase tracking-wide text-white/50">Apache 2.0 · cloud or self-host</p>
      </section>

      <section className="flex items-center justify-center bg-gray-50 px-5 py-12">
        <div className="w-full max-w-md">
          <div className="mb-6 flex justify-center text-slate-950 lg:hidden">
            <Logo height={24} />
          </div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            {mode === 'signup' ? 'Create account' : 'Sign in'}
          </p>
          <h1 className="mb-5 mt-2 text-3xl font-bold text-slate-950">
            {mode === 'signup' ? 'Start a workspace' : 'Welcome back'}
          </h1>

          <div className="space-y-4">
            {googleEnabled ? <GoogleButton redirectTo={afterAuth} /> : null}
            <MagicLinkForm mode={mode} redirectTo={afterAuth} />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="w-full text-center text-sm text-gray-500 underline hover:text-gray-700"
            >
              {showPassword ? 'Hide password sign-in' : 'Use a password instead'}
            </button>
          </div>

          <form
            key={mode}
            className="mt-4 space-y-4"
            action={formAction}
            style={{ display: showPassword ? undefined : 'none' }}
          >
            <input type="hidden" name="redirect" value={redirect || ''} />
            <input type="hidden" name="inviteId" value={inviteId || ''} />
            <div>
              <Label htmlFor="email" className="block text-sm font-medium text-gray-700">
                Email
              </Label>
              <div className="mt-1">
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  defaultValue={state.email}
                  required
                  maxLength={50}
                  className="w-full"
                  placeholder="you@company.com"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="password" className="block text-sm font-medium text-gray-700">
                Password
              </Label>
              <div className="mt-1">
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  defaultValue={state.password}
                  required
                  minLength={8}
                  maxLength={100}
                  className="w-full"
                  placeholder="••••••••"
                />
              </div>
            </div>
            {state?.error ? (
              <p role="alert" className="text-sm font-medium text-red-600">
                {state.error}
              </p>
            ) : null}
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Loading
                </>
              ) : mode === 'signin' ? (
                'Sign in'
              ) : (
                'Create account'
              )}
            </Button>
          </form>

          <p className="mt-6 text-sm text-gray-600">
            {mode === 'signup' ? 'Already have an account? ' : 'Need an account? '}
            <button
              type="button"
              className="font-semibold text-slate-950 underline"
              onClick={() => setMode(mode === 'signup' ? 'signin' : 'signup')}
            >
              {mode === 'signup' ? 'Sign in' : 'Create an account'}
            </button>
          </p>
        </div>
      </section>
    </main>
  );
}
