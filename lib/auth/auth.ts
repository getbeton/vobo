import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { db } from '@/lib/db/drizzle';
import { user, session, account, verification } from '@/lib/db/schema';

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
  plugins: [nextCookies()],
});

export type AuthSession = typeof auth.$Infer.Session;
