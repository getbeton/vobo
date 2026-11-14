export const JUDGE_KEY_ENV = 'VOBO_JUDGE_OPENAI_API_KEY';
export const JUDGE_LEASE_MS = 120_000;
export const ALLOWED_JUDGE_HOSTS = new Set(['api.openai.com']);

export function resolveJudgeBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw Object.assign(new Error('judge_base_url_rejected'), { class: 'config' });
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_JUDGE_HOSTS.has(parsed.hostname)) {
    throw Object.assign(new Error('judge_base_url_rejected'), { class: 'config' });
  }
  return `${parsed.origin}/v1`;
}
