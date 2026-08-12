/**
 * Transactional email. Resend over plain fetch — no SDK, because this sends
 * exactly two kinds of message and an extra dependency would be the larger
 * cost.
 *
 * With no RESEND_API_KEY the send is a no-op that logs the link instead of
 * throwing. That is deliberate for a self-hostable tool: `npm run dev` and a
 * fresh clone must be able to complete a sign-in without anyone configuring a
 * mail provider first. It is loud, so nobody mistakes a dev fallback for a
 * delivered email.
 */

const ENDPOINT = 'https://api.resend.com/emails';

export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

export async function sendMail(mail: Mail): Promise<{ delivered: boolean }> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM ?? 'Vobo <noreply@getbeton.ai>';

  if (!key) {
    console.warn(
      `[email] RESEND_API_KEY not set — NOT delivering "${mail.subject}" to ${mail.to}.\n` +
        `[email] Link, for local use only:\n${mail.text}`
    );
    return { delivered: false };
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, html: mail.html, text: mail.text }),
  });

  if (!res.ok) {
    // Surface it: a swallowed failure here means a user waiting forever for a
    // link that was never sent.
    throw new Error(`[email] Resend rejected the send (${res.status}): ${await res.text()}`);
  }
  return { delivered: true };
}

const shell = (heading: string, body: string, url: string, cta: string) => `
<div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#0f172a">
  <div style="font-weight:600;font-size:15px;letter-spacing:-.01em;margin-bottom:24px">Vobo</div>
  <h1 style="font-size:20px;font-weight:600;margin:0 0 12px">${heading}</h1>
  <p style="font-size:14px;line-height:1.6;color:#475569;margin:0 0 24px">${body}</p>
  <a href="${url}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-size:14px;font-weight:500;padding:10px 18px;border-radius:8px">${cta}</a>
  <p style="font-size:12px;line-height:1.6;color:#94a3b8;margin:24px 0 0">
    Or paste this into your browser:<br><span style="word-break:break-all">${url}</span>
  </p>
  <p style="font-size:12px;line-height:1.6;color:#94a3b8;margin:16px 0 0">
    If you did not ask for this, ignore it — nothing happens until the link is opened.
  </p>
</div>`;

export function magicLinkMail(to: string, url: string): Mail {
  return {
    to,
    subject: 'Your Vobo sign-in link',
    html: shell('Sign in to Vobo', 'This link signs you in and expires shortly.', url, 'Sign in'),
    text: `Sign in to Vobo: ${url}\n\nThe link expires shortly. If you did not ask for it, ignore this.`,
  };
}

export function verificationMail(to: string, url: string): Mail {
  return {
    to,
    subject: 'Confirm your email for Vobo',
    html: shell(
      'Confirm your email',
      'Confirming proves the address is yours. Until then the account cannot sign in.',
      url,
      'Confirm email'
    ),
    text: `Confirm your email for Vobo: ${url}\n\nUntil then the account cannot sign in.`,
  };
}
