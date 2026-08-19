#!/usr/bin/env node
/**
 * Remove the demo teammates from a live workspace.
 *
 * `npm run db:seed:demo` used to write its fixtures into the owner's real
 * workspace. It was run against production, so app.vobo.dev lists three people
 * who do not exist — Mara Kim, Jonas Størm, Ana López — and a pending invite
 * for tom@betonlabs.dev that nobody sent.
 *
 * It deletes the MEMBERSHIP, not the user. The demo seed drives claim, comment,
 * score, ship and repin as those three (lib/db/seed-demo.ts), so they author
 * decisions, annotations, leases, criteria verdicts and signed events on the
 * demo requests. Those requests stay, by decision on 2026-08-19. Deleting the
 * user rows would break foreign keys and leave the hash-chained event log with
 * a dangling author. Dropping the membership takes them off the members list
 * and revokes every access path; the history still renders a name.
 *
 *   POSTGRES_URL=... node scripts/purge-demo-members.mjs            # dry run
 *   POSTGRES_URL=... node scripts/purge-demo-members.mjs --commit
 *
 * Prints no secret and no connection string.
 */
import postgres from 'postgres';

const COMMIT = process.argv.includes('--commit');
const EMAILS = ['mara@betonlabs.dev', 'jonas@betonlabs.dev', 'ana@betonlabs.dev'];
const INVITE_EMAIL = 'tom@betonlabs.dev';

const url = process.env.POSTGRES_URL;
if (!url) {
  console.error('POSTGRES_URL is required');
  process.exit(1);
}
const sql = postgres(url, { ssl: 'prefer', max: 2 });

/**
 * Tables that carry a user id and would break on a user delete. `events` is
 * absent on purpose: it has no author column — the actor lives inside the
 * signed `payload`, which is exactly why the user rows must survive.
 */
const AUTHORED = [
  ['decisions', 'decided_by'],
  ['annotations', 'author_user_id'],
  ['leases', 'user_id'],
  ['criteria_verdicts', 'user_id'],
  ['policy_versions', 'created_by'],
  ['repin_history', 'user_id'],
  ['activity_logs', 'user_id'],
];

async function main() {
  console.log(COMMIT ? 'MODE: commit\n' : 'MODE: dry run — nothing is written\n');

  const users = await sql`
    select id, name, email from "user" where email = any(${EMAILS})
  `;
  if (users.length === 0) {
    console.log('No demo users found. Nothing to do.');
    return;
  }

  const memberships = await sql`
    select m.id, m.role, m.workspace_id, w.name as workspace_name, u.email
    from workspace_members m
    join "user" u on u.id = m.user_id
    join workspaces w on w.id = m.workspace_id
    where u.email = any(${EMAILS})
  `;

  // Never strand a workspace without an admin — same rule as
  // lib/actions/admin.ts setMemberRoleAction.
  for (const m of memberships.filter((r) => r.role === 'admin')) {
    const admins = await sql`
      select count(*)::int as n from workspace_members
      where workspace_id = ${m.workspace_id} and role = 'admin'
    `;
    if (admins[0].n <= 1) {
      console.error(
        `Refusing: ${m.email} is the only admin of workspace ${m.workspace_id} ` +
          `("${m.workspace_name}"). Promote someone else first.`
      );
      process.exit(1);
    }
  }

  const invites = await sql`
    select id, workspace_id, email, status from invitations where email = ${INVITE_EMAIL}
  `;

  console.log('Users found (KEPT — they author review history):');
  for (const u of users) {
    const counts = [];
    for (const [table, column] of AUTHORED) {
      const rows = await sql`
        select count(*)::int as n from ${sql(table)} where ${sql(column)} = ${u.id}
      `;
      if (rows[0].n > 0) counts.push(`${table}=${rows[0].n}`);
    }
    console.log(`  ${u.email.padEnd(24)} ${u.name.padEnd(14)} ${counts.join(' ') || 'no history'}`);
  }

  console.log('\nMemberships to delete:');
  for (const m of memberships) {
    console.log(`  ${m.email.padEnd(24)} workspace ${m.workspace_id} ("${m.workspace_name}") · ${m.role}`);
  }
  if (memberships.length === 0) console.log('  (none)');

  console.log('\nInvitations to delete:');
  for (const i of invites) {
    console.log(`  ${i.email.padEnd(24)} workspace ${i.workspace_id} · ${i.status}`);
  }
  if (invites.length === 0) console.log('  (none)');

  if (memberships.length === 0 && invites.length === 0) {
    console.log('\nNothing to do.');
    return;
  }

  if (!COMMIT) {
    console.log(
      `\nDry run. Re-run with --commit to delete ${memberships.length} membership(s) ` +
        `and ${invites.length} invitation(s). No user row is deleted, ever.`
    );
    return;
  }

  await sql.begin(async (tx) => {
    if (memberships.length) {
      await tx`delete from workspace_members where id = any(${memberships.map((m) => m.id)})`;
    }
    if (invites.length) {
      await tx`delete from invitations where id = any(${invites.map((i) => i.id)})`;
    }
  });

  console.log(
    `\nDeleted ${memberships.length} membership(s) and ${invites.length} invitation(s). ` +
      `${users.length} user row(s) kept.`
  );
}

main()
  .catch((error) => {
    console.error('purge-demo-members failed:', error.message ?? error);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
