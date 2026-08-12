#!/usr/bin/env node
// Merge two user rows that are the same human (VOBO-168).
//
// Google sign-in shipped after email/password, so an address can already exist
// twice — once as a credential account, once as a Google identity that failed
// to link. Automatic linking handles the clean case going forward; this is for
// pairs that already diverged.
//
// Attribution is the reason this is careful rather than a DELETE. Verdicts,
// annotations and repins are the audit trail behind signed events: if a
// decision loses its author the Timeline stops answering "who accepted this".
// So every reference moves to the surviving user before the other row goes.
//
//   node scripts/merge-users.mjs --keep <email|id> --merge <email|id> [--apply]
//
// Dry-run by default: prints exactly what it WOULD move and changes nothing.
// The event hash chain is untouched either way — event payloads are already
// sealed, so a merge never rewrites history, it only re-points foreign keys.

import postgres from 'postgres';

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
}
const APPLY = args.includes('--apply');
const keepRef = flag('keep');
const mergeRef = flag('merge');

if (!keepRef || !mergeRef) {
  console.error('usage: merge-users.mjs --keep <email|id> --merge <email|id> [--apply]');
  process.exit(2);
}

const url = process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('POSTGRES_URL is not set');
  process.exit(2);
}
const sql = postgres(url, { max: 1 });

// column → table map, derived from every FK onto "user".id.
const REFERENCES = [
  ['workspace_members', 'user_id'],
  ['activity_logs', 'user_id'],
  ['annotations', 'author_user_id'],
  ['annotations', 'resolved_by'],
  ['criteria_verdicts', 'user_id'],
  ['decisions', 'decided_by'],
  ['invitations', 'invited_by'],
  ['leases', 'user_id'],
  ['policy_versions', 'created_by'],
  ['repin_history', 'user_id'],
  ['review_requests', 'sticky_reviewer_id'],
];

async function resolveUser(ref) {
  const rows = ref.includes('@')
    ? await sql`select id, email, email_verified, created_at from "user" where lower(email) = lower(${ref})`
    : await sql`select id, email, email_verified, created_at from "user" where id = ${ref}`;
  if (rows.length === 0) throw new Error(`no user matches ${ref}`);
  return rows[0];
}

try {
  const keep = await resolveUser(keepRef);
  const merge = await resolveUser(mergeRef);
  if (keep.id === merge.id) throw new Error('--keep and --merge are the same user');

  console.log(`keep   ${keep.id}  ${keep.email}  verified=${keep.email_verified}`);
  console.log(`merge  ${merge.id}  ${merge.email}  verified=${merge.email_verified}`);
  if (keep.email.toLowerCase() !== merge.email.toLowerCase()) {
    console.log('NOTE: addresses differ — merging distinct addresses, make sure that is intended');
  }
  console.log('');

  let total = 0;
  for (const [table, column] of REFERENCES) {
    const [{ count }] = await sql`
      select count(*)::int as count from ${sql(table)} where ${sql(column)} = ${merge.id}`;
    if (count > 0) {
      console.log(`  ${String(count).padStart(5)}  ${table}.${column}`);
      total += count;
    }
  }
  const [{ count: sessions }] = await sql`
    select count(*)::int as count from session where user_id = ${merge.id}`;
  const [{ count: accounts }] = await sql`
    select count(*)::int as count from account where user_id = ${merge.id}`;
  console.log(`  ${String(sessions).padStart(5)}  session.user_id        (revoked, not moved)`);
  console.log(`  ${String(accounts).padStart(5)}  account.user_id        (credentials moved)`);
  console.log(`\n  ${total} rows would be re-pointed to ${keep.id}`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing changed. Re-run with --apply to perform the merge.');
    process.exit(0);
  }

  await sql.begin(async (tx) => {
    for (const [table, column] of REFERENCES) {
      if (table === 'workspace_members') {
        // A shared workspace would collide on the (user, workspace) unique
        // index, so drop the loser's duplicate rather than moving it.
        await tx`
          delete from workspace_members wm
          where wm.user_id = ${merge.id}
            and exists (select 1 from workspace_members k
                        where k.user_id = ${keep.id} and k.workspace_id = wm.workspace_id)`;
      }
      await tx`update ${tx(table)} set ${tx(column)} = ${keep.id} where ${tx(column)} = ${merge.id}`;
    }
    // Sessions are not transferable — force a fresh sign-in.
    await tx`delete from session where user_id = ${merge.id}`;
    // Keep the merged identity's provider links so its Google login still works.
    await tx`
      update account set user_id = ${keep.id}
      where user_id = ${merge.id}
        and not exists (select 1 from account k
                        where k.user_id = ${keep.id} and k.provider_id = account.provider_id)`;
    await tx`delete from account where user_id = ${merge.id}`;
    await tx`delete from "user" where id = ${merge.id}`;
  });

  console.log(`\nMERGED. ${merge.email} (${merge.id}) is gone; everything now belongs to ${keep.id}.`);
} catch (err) {
  console.error(`merge failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
