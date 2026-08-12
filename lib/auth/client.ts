'use client';

import { createAuthClient } from 'better-auth/react';
import { magicLinkClient } from 'better-auth/client/plugins';

/**
 * Browser-side auth client. Social sign-in and magic links both have to start
 * from the browser — the provider (or the mailbox) carries the user away and
 * back — so neither can run through the server actions the password flow uses.
 */
export const authClient = createAuthClient({
  plugins: [magicLinkClient()],
});

export const { signIn: clientSignIn, signOut: clientSignOut, useSession } = authClient;
