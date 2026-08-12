'use client';

import { createAuthClient } from 'better-auth/react';

/**
 * Browser-side auth client. Social sign-in has to start from the browser (the
 * provider redirect carries the user away and back), so it cannot run through
 * the server actions the email/password flow uses.
 */
export const authClient = createAuthClient();

export const { signIn: clientSignIn, signOut: clientSignOut, useSession } = authClient;
