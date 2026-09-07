import { describe, it, expect } from 'vitest';
import { homeAction, safeInternalPath } from '../paths';

describe('homeAction — cookie is optimistic, auth pages never bounce', () => {
  it('logged-out / rewrites to /auth', () => {
    expect(homeAction('/', false)).toEqual({ kind: 'rewrite', to: '/auth' });
  });

  it('cookie on / rewrites to /admin (layout still validates the session)', () => {
    expect(homeAction('/', true)).toEqual({ kind: 'rewrite', to: '/admin' });
  });

  it('does not bounce /auth, /sign-in, or /sign-up when a cookie is present', () => {
    expect(homeAction('/auth', true)).toEqual({ kind: 'next' });
    expect(homeAction('/sign-in', true)).toEqual({ kind: 'next' });
    expect(homeAction('/sign-up', true)).toEqual({ kind: 'next' });
    expect(homeAction('/auth', false)).toEqual({ kind: 'next' });
  });

  it('dashboard bookmarks redirect; query is not part of the decision', () => {
    expect(homeAction('/dashboard', true)).toEqual({ kind: 'redirect', to: '/' });
    expect(homeAction('/dashboard/security', false)).toEqual({
      kind: 'redirect',
      to: '/auth',
    });
  });

  it('other app routes pass through', () => {
    expect(homeAction('/queue', true)).toEqual({ kind: 'next' });
    expect(homeAction('/admin', false)).toEqual({ kind: 'next' });
  });
});

describe('safeInternalPath', () => {
  it('keeps a relative in-app path', () => {
    expect(safeInternalPath('/admin')).toBe('/admin');
    expect(safeInternalPath('/welcome')).toBe('/welcome');
    expect(safeInternalPath('/queue?project=pico')).toBe('/queue?project=pico');
  });

  it('rejects open redirects', () => {
    expect(safeInternalPath('https://evil.example')).toBeNull();
    expect(safeInternalPath('//evil.example')).toBeNull();
    expect(safeInternalPath('/\\evil.example')).toBeNull();
    expect(safeInternalPath('http://evil.example/x')).toBeNull();
    expect(safeInternalPath('')).toBeNull();
    expect(safeInternalPath(null)).toBeNull();
  });
});
