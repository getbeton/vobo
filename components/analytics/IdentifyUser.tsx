'use client';

import { useEffect } from 'react';
import { posthog } from '@/lib/analytics/browser';
import { useSession } from '@/lib/auth/client';

/** Stitch the anonymous device to the signed-in user. Id only — no email. */
export function IdentifyUser() {
  const { data } = useSession();
  const userId = data?.user?.id;

  useEffect(() => {
    if (!userId) return;
    posthog.identify(userId);
  }, [userId]);

  return null;
}
