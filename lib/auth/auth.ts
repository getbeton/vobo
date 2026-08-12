import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { db } from '@/lib/db/drizzle';
import { user, session, account, verification } from '@/lib/db/schema';

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: { user, session, account, verification },
  }),
  secret: process.env.BETTER_AUTH_SECRET ?? process.env.AUTH_SECRET,
  emailAndPassword: {
    enabled: true,
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
