import type { IncomingFinding } from '@/lib/findings/ingest';

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(?<!\d)(?:\+?\d[\d\s().-]{8,}\d)/g;

/**
 * Cheap regex producer. Not Presidio. Flags emails and phone-shaped numbers
 * so an admin can confirm before the artifact sits in a training path.
 */
export function detectPii(content: string): IncomingFinding[] {
  const findings: IncomingFinding[] = [];
  const seen = new Set<string>();

  for (const match of content.matchAll(EMAIL)) {
    const quote = match[0];
    if (seen.has(quote)) continue;
    seen.add(quote);
    findings.push({
      criterion: 'pii',
      severity: 'critical',
      selector: { quote },
      evidence: quote,
      note: 'Email address in the artifact. Confirm or dismiss before this request can enter a training path.',
    });
  }
  for (const match of content.matchAll(PHONE)) {
    const quote = match[0].trim();
    if (quote.replace(/\D/g, '').length < 10) continue;
    if (seen.has(quote)) continue;
    seen.add(quote);
    findings.push({
      criterion: 'pii',
      severity: 'critical',
      selector: { quote },
      evidence: quote,
      note: 'Phone-shaped number in the artifact. Confirm or dismiss.',
    });
  }
  return findings;
}
