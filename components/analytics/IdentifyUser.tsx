'use client';

import { useEffect } from 'react';
import { posthog } from '@/lib/analytics/browser';
import { useSession } from '@/lib/auth/client';

/** Stitch the anonymous device to the signed-in user. */
export function IdentifyUser() {
  const { data } = useSession();
  const user = data?.user;

  useEffect(() => {
    if (!user?.id) return;
    posthog.identify(user.id, {
      email: user.email,
      name: user.name,
    });
  }, [user?.id, user?.email, user?.name]);

  return null;
}
