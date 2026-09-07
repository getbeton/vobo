/**
 * Auth URL helpers. Middleware must not treat cookie presence as a valid
 * session — that is what closed `/` ↔ `/auth` into a redirect loop.
 */

export type HomeAction =
  | { kind: 'rewrite'; to: '/admin' | '/auth' }
  | { kind: 'redirect'; to: '/' | '/auth' }
  | { kind: 'next' };

/** Cookie presence only steers `/` and leftover `/dashboard*`. Auth pages stay put. */
export function homeAction(pathname: string, hasCookie: boolean): HomeAction {
  if (pathname === '/') {
    return { kind: 'rewrite', to: hasCookie ? '/admin' : '/auth' };
  }
  if (pathname === '/dashboard' || pathname.startsWith('/dashboard/')) {
    return { kind: 'redirect', to: hasCookie ? '/' : '/auth' };
  }
  return { kind: 'next' };
}

/**
 * Relative in-app path only. Reject protocol-relative, backslash, and
 * absolute URL values that Better Auth would honour as callbackURL.
 */
export function safeInternalPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const path = raw.trim();
  if (!path.startsWith('/')) return null;
  if (path.startsWith('//')) return null;
  if (path.includes('\\')) return null;
  if (path.includes('://')) return null;
  return path;
}
