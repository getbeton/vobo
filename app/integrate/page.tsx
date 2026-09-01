import { INTEGRATE_COPY } from '@/lib/core/pull-contract';

export const dynamic = 'force-static';

/**
 * Agent-facing loop contract (ARD §49.3). Public, one scroll, no app chrome.
 */
export default function IntegratePage() {
  return (
    <main
      style={{
        maxWidth: 72 * 8,
        margin: '0 auto',
        padding: '32px 24px 64px',
        color: '#0f172a',
        background: '#fff',
        minHeight: '100dvh',
      }}
    >
      <pre
        style={{
          margin: 0,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 14,
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
        }}
      >
        {INTEGRATE_COPY}
      </pre>
    </main>
  );
}
