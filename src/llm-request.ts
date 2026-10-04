export interface LlmHttpResponse { status: number; json: unknown; headers?: Record<string, string> }
export type Transport = (url: string, headers: Record<string, string>, body: string) => Promise<LlmHttpResponse>;
export interface RetryFeedback { cancelled?: () => boolean; onRetry?: (delayMs: number, retry: number) => void }

function quotaExhausted(json: unknown): boolean {
  const error = (json as { error?: { code?: unknown; type?: unknown; message?: unknown } } | null)?.error;
  const code = [error?.code, error?.type].filter(x => typeof x === 'string').join(' ').toLowerCase();
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  return /insufficient_quota|quota_exceeded|billing_hard_limit|insufficient_balance|balance_insufficient|credit_balance/.test(code)
    || /exceeded your current quota|insufficient (?:credit|balance)|credit balance.*(?:low|exhaust|insufficient)|billing.*(?:limit|quota)|daily (?:quota|limit).*(?:exceed|exhaust)/.test(message);
}

export function retryDelay(response: LlmHttpResponse, retry: number, now = Date.now()): number {
  const headers = Object.fromEntries(Object.entries(response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (headers['retry-after-ms'] && /^\d+(?:\.\d+)?$/.test(headers['retry-after-ms'])) return Math.ceil(Number(headers['retry-after-ms']));
  const after = headers['retry-after']?.trim();
  if (after) {
    if (/^\d+(?:\.\d+)?$/.test(after)) return Math.ceil(Number(after) * 1000);
    const date = Date.parse(after); if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const details = (response.json as { error?: { details?: unknown } } | null)?.error?.details;
  if (Array.isArray(details)) {
    const delay = details.find(d => d?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo')?.retryDelay;
    if (typeof delay === 'string' && /^\d+(?:\.\d+)?s$/.test(delay)) return Math.ceil(parseFloat(delay) * 1000);
  }
  return Math.ceil(1000 * 2 ** (retry - 1) * (1 + Math.random() * 0.25));
}

/** Retry only explicit rate-limit responses, before any local write or tool execution. */
export async function requestLlm(url: string, headers: Record<string, string>, body: string, transport: Transport, timeoutMs: number, feedback: RetryFeedback = {}): Promise<LlmHttpResponse> {
  const deadline = Date.now() + timeoutMs;
  const check = () => { if (feedback.cancelled?.()) throw new Error('Chat was closed; no tasks were written.'); };
  for (let attempt = 0; attempt < 3; attempt++) {
    check();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('LLM request timed out. No tasks were written.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: LlmHttpResponse;
    try {
      response = await Promise.race([transport(url, headers, body), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timeout')), remaining);
      })]);
    } catch {
      throw new Error('LLM request failed or timed out. Check your network and provider settings. No tasks were written.');
    } finally { if (timer) clearTimeout(timer); }
    check();
    if (response.status >= 200 && response.status < 300) return response;
    if (response.status === 429) {
      if (quotaExhausted(response.json)) throw new Error('LLM returned HTTP 429: provider quota or credit balance exhausted. Check billing/usage with your provider, or select another configured provider/model. Automatic retries will not resolve this. No tasks were written.');
      const delay = retryDelay(response, attempt + 1);
      if (attempt === 2) throw new Error('LLM returned HTTP 429: still rate-limited after 3 attempts. Wait before resending, or select another configured model. No tasks were written.');
      if (delay > 30000 || delay >= deadline - Date.now()) throw new Error(`LLM returned HTTP 429: provider requires waiting ${Math.ceil(delay / 1000)} seconds, beyond the automatic retry budget. Wait before resending. No tasks were written.`);
      feedback.onRetry?.(delay, attempt + 1);
      await new Promise<void>(resolve => setTimeout(resolve, delay));
      continue;
    }
    const reason = response.status === 401 ? 'Authentication rejected. Check your API key.'
      : response.status === 403 ? 'Model access denied. Check your provider permissions.'
      : response.status === 404 ? 'Endpoint or model not found. Check the base URL and selected model.'
      : 'Check the selected model, API protocol and provider status.';
    // Never echo arbitrary provider bodies: they may contain credentials or echoed prompts.
    throw new Error(`LLM returned HTTP ${response.status}. ${reason} No tasks were written.`);
  }
  throw new Error('LLM retry limit reached. No tasks were written.');
}
