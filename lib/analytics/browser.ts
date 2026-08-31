import posthog from 'posthog-js';

function onVoboHost(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return host === 'vobo.dev' || host.endsWith('.vobo.dev');
}

/**
 * Browser PostHog. No-ops without a key so a self-hosted install does not
 * send events to the Vobo Cloud project. Cookie is scoped to `.vobo.dev` only
 * on those hosts so vobo.dev and app.vobo.dev share one anonymous person.
 */
export function initBrowserPostHog(key: string): void {
  if (typeof window === 'undefined' || !key) return;
  if ((posthog as unknown as { __loaded?: boolean }).__loaded) return;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';
  posthog.init(key, {
    api_host: host,
    ui_host: 'https://us.posthog.com',
    autocapture: true,
    capture_pageview: false,
    capture_pageleave: true,
    person_profiles: 'always',
    persistence: 'cookie',
    cross_subdomain_cookie: onVoboHost(),
  });
}

export function capturePageview(): void {
  if (typeof window === 'undefined') return;
  if (!(posthog as unknown as { __loaded?: boolean }).__loaded) return;
  posthog.capture('$pageview', { $current_url: window.location.href });
}

export { posthog };
