import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';

/**
 * `/` is the product: auth for a visitor, workspace for a signed-in user.
 * Cookie presence is optimistic — getUser() still validates the session.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const sessionCookie = getSessionCookie(request);

  if (pathname === '/') {
    if (sessionCookie) {
      return NextResponse.rewrite(new URL('/admin', request.url));
    }
    return NextResponse.rewrite(new URL('/auth', request.url));
  }

  if (
    sessionCookie &&
    (pathname === '/auth' || pathname === '/sign-in' || pathname === '/sign-up')
  ) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  if (pathname === '/dashboard' || pathname.startsWith('/dashboard/')) {
    return NextResponse.redirect(new URL(sessionCookie ? '/' : '/auth', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
