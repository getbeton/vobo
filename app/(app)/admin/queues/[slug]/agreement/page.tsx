import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { getUser, currentMembership } from '@/lib/db/queries';
import { projects, queues } from '@/lib/db/schema';
import { AGREEMENT_MIN_N, blindFindingCounts, sightedAgreement } from '@/lib/judge/agreement';

export const dynamic = 'force-dynamic';

export default async function AgreementPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ project?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const me = await getUser();
  if (!me) redirect('/auth');
  const membership = await currentMembership(me.id);
  if (!membership) redirect('/auth');

  const projectRows = await db
    .select()
    .from(projects)
    .where(eq(projects.workspaceId, membership.workspaceId));
  const project = sp.project ? projectRows.find((p) => p.slug === sp.project) : projectRows[0];
  if (!project) notFound();
  const queue = await db.query.queues.findFirst({
    where: and(eq(queues.projectId, project.id), eq(queues.slug, slug), eq(queues.environment, 'production')),
  });
  if (!queue) notFound();

  const sighted = await sightedAgreement(db, queue.id);
  const blind = await blindFindingCounts(db, queue.id);
  const blindOn = blind.some((b) => b.n > 0);

  return (
    <div style={{ padding: '28px 32px' }}>
      <div style={{ maxWidth: 800, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Link href={`/admin/queues/${slug}?project=${project.slug}`} style={{ fontSize: 13, color: 'var(--slate-600)' }}>
          ← {slug}
        </Link>
        <h1 className="k-title" style={{ fontSize: 22 }}>
          Judge-vs-human agreement
        </h1>
        <p style={{ fontSize: 13, color: 'var(--slate-600)', lineHeight: 1.5 }}>
          Sighted agreement comes from triage. Blind agreement is a separate family and is the only
          number that may justify reducing human coverage. Reviewers are not ground truth.
        </p>
        <h2 style={{ fontSize: 14 }}>Sighted</h2>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th align="left">Criterion</th>
              <th align="right">Emitted</th>
              <th align="right">Confirmed</th>
              <th align="right">Dismissed</th>
              <th align="right">Confirm rate</th>
            </tr>
          </thead>
          <tbody>
            {sighted.map((r) => (
              <tr key={r.criterionKey}>
                <td>{r.criterionKey}</td>
                <td align="right">{r.emitted}</td>
                <td align="right">{r.confirmed}</td>
                <td align="right">{r.dismissed}</td>
                <td align="right">
                  {r.confirmRate == null
                    ? `not enough data (n < ${AGREEMENT_MIN_N})`
                    : `${Math.round(r.confirmRate * 100)}%`}
                </td>
              </tr>
            ))}
            {sighted.length === 0 && (
              <tr>
                <td colSpan={5} style={{ color: 'var(--slate-500)' }}>
                  No triaged findings yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <h2 style={{ fontSize: 14 }}>Blind</h2>
        {!blindOn ? (
          <p style={{ fontSize: 13, color: 'var(--slate-600)' }}>
            Blind sampling is off. Agreement on this page is not a basis for cutting coverage.
          </p>
        ) : (
          <ul style={{ fontSize: 13 }}>
            {blind.map((b) => (
              <li key={b.criterionKey}>
                {b.criterionKey}: {b.n} withheld finding{b.n === 1 ? '' : 's'}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
