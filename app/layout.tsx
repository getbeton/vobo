import './globals.css';
import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { GeistMono } from 'geist/font/mono';
import { Suspense } from 'react';
import { getUser, getWorkspaceForUser } from '@/lib/db/queries';
import { SWRConfig } from 'swr';
import { AnalyticsTracker } from '@/components/analytics/AnalyticsProvider';

export const metadata: Metadata = {
  title: 'Vobo',
  description:
    'Review station for AI pipeline output — anchored corrections, versioned regenerations, signed decisions.',
};

export const viewport: Viewport = {
  maximumScale: 1,
};

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`bg-white text-foreground ${inter.variable} ${GeistMono.variable} ${inter.className}`}
    >
      <body className="min-h-[100dvh] bg-background">
        <SWRConfig
          value={{
            fallback: {
              // We do NOT await here — only components reading this suspend
              '/api/user': getUser(),
              '/api/workspace': getWorkspaceForUser(),
            },
          }}
        >
          <Suspense fallback={null}>
            <AnalyticsTracker />
          </Suspense>
          {children}
        </SWRConfig>
      </body>
    </html>
  );
}
