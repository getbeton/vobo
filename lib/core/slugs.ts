/**
 * Entity slugs (project / queue). Workspace slugs are minted at signup with a
 * random suffix (`lib/auth/bootstrap.ts`) so two people can share a local
 * part; these are operator-chosen identities and must collide loudly.
 */

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 64 && SLUG_RE.test(slug);
}
