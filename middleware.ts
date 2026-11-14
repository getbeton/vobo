import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';
import { homeAction } from '@/lib/auth/paths';

/**
 * `/` is the product: auth for a visitor, workspace for a signed-in user.
 * Cookie presence is optimistic — getUser() still validates the session.
 * Auth pages are not bounced here. A stale cookie would otherwise loop
 * `/` → `/admin` → `/auth` → `/`.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const sessionCookie = getSessionCookie(request);
  const action = homeAction(pathname, Boolean(sessionCookie));

  if (action.kind === 'rewrite') {
    return NextResponse.rewrite(new URL(action.to, request.url));
  }
  if (action.kind === 'redirect') {
    return NextResponse.redirect(new URL(action.to, request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
