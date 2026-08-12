import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { magicLink } from 'better-auth/plugins';
import { db } from '@/lib/db/drizzle';
import { user, session, account, verification } from '@/lib/db/schema';
import { sendMail, magicLinkMail, verificationMail } from '@/lib/email/send';

/**
 * Google sign-in is per-deployment: each environment gets its own OAuth client
 * so a staging consent screen can never mint a production session. Absent
 * credentials means the provider is simply not registered — a self-hosted
 * install must work with email + password alone.
 */
const googleId = process.env.GOOGLE_CLIENT_ID;
const googleSecret = process.env.GOOGLE_CLIENT_SECRET;
export const googleAuthEnabled = Boolean(googleId && googleSecret);

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: { user, session, account, verification },
  }),
  secret: process.env.BETTER_AUTH_SECRET ?? process.env.AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  emailAndPassword: {
    enabled: true,
    // Ownership of the address must be proven before the account is usable.
    // Without this, anyone can register an address they do not own and sit on
    // it — which is the squatting case lib/auth/linking.ts exists to survive.
    requireEmailVerification: true,
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user: recipient, url }) => {
      await sendMail(verificationMail(recipient.email, url));
    },
  },
  socialProviders: googleAuthEnabled
    ? {
        google: {
          clientId: googleId!,
          clientSecret: googleSecret!,
          // An existing email/password account adopts the Google identity
          // instead of colliding with it.
          mapProfileToUser: (profile) => ({ name: profile.name, image: profile.picture }),
        },
      }
    : undefined,
  databaseHooks: {
    user: {
      create: {
        // One canonical form for every address: trimmed + lowercased. Case is
        // the only normalisation applied — Gmail's dots and +tags are Google's
        // own convention, and collapsing them would merge addresses that other
        // providers treat as distinct people. See VOBO-168.
        before: async (creating) => ({
          data: { ...creating, email: creating.email.trim().toLowerCase() },
        }),
        // Every path that can create a user runs through here — email,
        // Google, and anything added later — including a social callback that
        // redirects somewhere other than /welcome. Invitation-aware: an
        // invited address joins the inviting workspace and gets no stray
        // personal one, while everyone else still ends up with exactly one.
        // Idempotent, so the later paths are free to call it again.
        after: async (created) => {
          const { assignWorkspaceOnSignup } = await import('./bootstrap');
          await assignWorkspaceOnSignup(created.id, created.email);
        },
      },
    },
    account: {
      create: {
        // Fires when a Google identity attaches to a user — new or existing.
        // Existing is the interesting case: see lib/auth/linking.ts for why an
        // unproven local password does not survive it.
        after: async (created) => {
          if (created.providerId !== 'google') return;
          const { reconcileOnGoogleLink } = await import('./linking');
          await reconcileOnGoogleLink(created.userId);
        },
      },
    },
  },
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ['google'],
    },
  },
  user: {
    deleteUser: {
      enabled: true,
    },
  },
  // nextCookies must be last: makes auth.api.* calls inside server actions
  // set/clear cookies correctly.
  plugins: [
    // Magic link is the preferred email path. Opening the link proves control
    // of the mailbox, so it authenticates and verifies in one step — there is
    // no unproven-address window and no password to plant or leak.
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await sendMail(magicLinkMail(email, url));
      },
    }),
    nextCookies(),
  ],
});

export type AuthSession = typeof auth.$Infer.Session;
