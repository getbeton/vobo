'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { capturePageview, initBrowserPostHog } from '@/lib/analytics/browser';
import { IdentifyUser } from './IdentifyUser';

/**
 * Boots PostHog once from NEXT_PUBLIC_POSTHOG_KEY. No-ops without a key.
 * Pageviews fire on App Router navigations (init turns the automatic one off
 * so the first view is not counted twice).
 */
export function AnalyticsProvider({ children }: { children: ReactNode }) {
  const [booted, setBooted] = useState(false);
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? '';
    if (!key) return;
    initBrowserPostHog(key);
    setBooted(true);
  }, []);

  useEffect(() => {
    if (!booted) return;
    capturePageview();
  }, [booted, pathname, searchParams]);

  return (
    <>
      {booted ? <IdentifyUser /> : null}
      {children}
    </>
  );
}
