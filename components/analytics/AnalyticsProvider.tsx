'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { capturePageview, initBrowserPostHog } from '@/lib/analytics/browser';
import { IdentifyUser } from './IdentifyUser';

/**
 * Boots PostHog once from NEXT_PUBLIC_POSTHOG_KEY. No-ops without a key.
 * Do not wrap page children in this component — keep the tracker in its own
 * Suspense boundary so search-params do not blank the shell.
 */
export function AnalyticsTracker() {
  const [booted, setBooted] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? '';
    if (!key) return;
    try {
      initBrowserPostHog(key);
      setBooted(true);
    } catch (err) {
      console.warn('posthog init failed (non-fatal):', err);
    }
  }, []);

  useEffect(() => {
    if (!booted) return;
    capturePageview();
  }, [booted, pathname]);

  return booted ? <IdentifyUser /> : null;
}
