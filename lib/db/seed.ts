import { randomBytes, createHash } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from './drizzle';
import { eq as eqOp } from 'drizzle-orm';
import {
  user as userTable,
  workspaces,
  workspaceMembers,
  projects,
  queues,
  policyVersions,
  criteria,
  apiKeys,
} from './schema';
import { auth } from '@/lib/auth/auth';
import { DEFAULT_POLICY } from '@/lib/core/policy';

/**
 * Dogfood seed: one workspace, the PICO project, the pico-cold-email queue
 * (production + test env twins), policy v1, the email rubric, and one
 * pipeline API key (token printed ONCE — store it in the secrets vault).
 */

const EMAIL_RUBRIC: Array<{ key: string; title: string; description: string }> = [
  {
    key: 'voice',
    title: 'Voice: direct, no marketing tone',
    description:
      'Simplified-Technical-English concision. No sycophancy, no filler, no exclamation marks.',
  },
  {
    key: 'subject',
    title: 'Subject line follows the subject rules',
    description: 'Short, specific, lowercase-leaning; no clickbait, no brackets.',
  },
  {
    key: 'no-signature',
    title: 'No signatures in cold copy',
    description: 'Cold emails end on the ask; no sign-off blocks.',
  },
  {
    key: 'warm-followup',
    title: 'Warm-thread style on follow-ups',
    description: 'Bumps and replies read like a colleague, not a sequence step.',
  },
  {
    key: 'no-dupes',
    title: 'No cross-sequence duplicate proof points',
    description: 'This contact has not seen the same proof point in another sequence.',
  },
  {
    key: 'persona',
    title: 'Persona-specific relevance',
    description: 'Narrow title targeting; the pain named is specific to this persona.',
  },
  {
    key: 'factual',
    title: 'Claims match the dossier',
    description:
      'Every claim traces to the account research. No invented customer names, no NDA leaks.',
  },
];

async function seed() {
  const email = process.env.SEED_EMAIL || 'v@getbeton.ai';
  const password = process.env.SEED_PASSWORD || randomBytes(12).toString('base64url');

  const existing = await db
    .select()
    .from(userTable)
    .where(eqOp(userTable.email, email))
    .limit(1);
  if (existing.length > 0) {
    console.log(`Seed user ${email} already exists — aborting (idempotent no-op).`);
    return;
  }

  const signUp = await auth.api.signUpEmail({
    body: { email, password, name: 'Vlad' },
  });
  const user = signUp.user;

  // Email verification is required to sign in, and nobody is going to click a
  // link for a seeded account — so the seed asserts the address itself.
  await db
    .update(userTable)
    .set({ emailVerified: true })
    .where(eqOp(userTable.id, user.id));

  // Signup already created a workspace (the user-create hook guarantees one).
  // Adopt it rather than inserting a second, or the seeded account lands in two.
  const membership = await db.query.workspaceMembers.findFirst({
    where: eqOp(workspaceMembers.userId, user.id),
  });
  const [ws] = await db
    .update(workspaces)
    .set({ name: 'Beton Labs', slug: 'beton-labs', policyDefaults: {} })
    .where(eqOp(workspaces.id, membership!.workspaceId))
    .returning();

  const [project] = await db
    .insert(projects)
    .values({ workspaceId: ws.id, name: 'PICO Outbound', slug: 'pico' })
    .returning();

  for (const environment of ['production', 'test'] as const) {
    const [queue] = await db
      .insert(queues)
      .values({
        projectId: project.id,
        name: 'pico-cold-email',
        slug: 'pico-cold-email',
        environment,
      })
      .returning();

    const [pv] = await db
      .insert(policyVersions)
      .values({
        queueId: queue.id,
        version: 1,
        config: {
          ...DEFAULT_POLICY,
          roundBudget: 3,
          blindN: 0,
          stickyRegenerations: true,
          slaMinutes: environment === 'production' ? 7 * 24 * 60 : null,
        },
        createdBy: user.id,
      })
      .returning();

    await db
      .update(queues)
      .set({ activePolicyVersionId: pv.id })
      .where(eq(queues.id, queue.id));

    await db.insert(criteria).values(
      EMAIL_RUBRIC.map((c, i) => ({
        queueId: queue.id,
        key: c.key,
        title: c.title,
        description: c.description,
        position: i,
      }))
    );
  }

  const token = `vobo_sk_${randomBytes(24).toString('base64url')}`;
  const keyHash = createHash('sha256').update(token).digest('hex');
  await db.insert(apiKeys).values({
    projectId: project.id,
    name: 'pico-pipeline',
    keyHash,
    keyPrefix: token.slice(0, 12),
  });

  console.log('Seed complete.');
  console.log(`  user:     ${email}`);
  if (!process.env.SEED_PASSWORD) console.log(`  password: ${password}  (generated — change it)`);
  console.log(`  API key:  ${token}`);
  console.log('  ^ printed ONCE. Store in ~/.claude/secrets/vobo.env');
}

seed()
  .catch((error) => {
    console.error('Seed process failed:', error);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
