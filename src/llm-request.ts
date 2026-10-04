export interface LlmHttpResponse { status: number; json: unknown; headers?: Record<string, string> }
export type Transport = (url: string, headers: Record<string, string>, body: string) => Promise<LlmHttpResponse>;
export interface RetryFeedback { cancelled?: () => boolean; signal?: AbortSignal; onRetry?: (delayMs: number, retry: number) => void }

function quotaExhausted(json: unknown): boolean {
  const error = (json as { error?: { code?: unknown; type?: unknown; message?: unknown } } | null)?.error;
  const code = [error?.code, error?.type].filter(x => typeof x === 'string').join(' ').toLowerCase();
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  return /insufficient_quota|billing_hard_limit|insufficient_balance|balance_insufficient|credit_balance/.test(code)
    || /exceeded your current quota|insufficient (?:credit|balance)|credit balance.*(?:low|exhaust|insufficient)|billing.*(?:limit|quota)/.test(message);
}

export function retryDelay(response: LlmHttpResponse, retry: number, now = Date.now()): number {
  const headers = Object.fromEntries(Object.entries(response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (headers['retry-after-ms'] && /^\d+(?:\.\d+)?$/.test(headers['retry-after-ms'])) return Math.ceil(Number(headers['retry-after-ms']));
  const after = headers['retry-after']?.trim();
  if (after) {
    if (/^\d+(?:\.\d+)?$/.test(after)) return Math.ceil(Number(after) * 1000);
    // HTTP-date is in the server's clock domain. Correct local clock skew using Date.
    const date = Date.parse(after), server = Date.parse(headers.date ?? '');
    if (Number.isFinite(date)) return Math.max(0, date - (Number.isFinite(server) ? server : now));
  }
  const details = (response.json as { error?: { details?: unknown } } | null)?.error?.details;
  if (Array.isArray(details)) {
    const delay = details.find(d => d?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo')?.retryDelay;
    if (typeof delay === 'string' && /^\d+(?:\.\d+)?s$/.test(delay)) return Math.ceil(parseFloat(delay) * 1000);
  }
  return Math.ceil(1000 * 2 ** (retry - 1) * (1 + Math.random() * 0.25));
}

/** Only emit recognized limit categories and numeric counters, never raw provider prose. */
export function rateLimitDetails(response: LlmHttpResponse): string {
  const headers = Object.fromEntries(Object.entries(response.headers ?? {}).map(([k,v]) => [k.toLowerCase(),v]));
  const error = (response.json as {error?: {code?: unknown; message?: unknown}} | null)?.error;
  const details: string[] = [];
  if (['rate_limit_exceeded','slow_down','quota_exceeded'].includes(String(error?.code))) details.push(`code=${error?.code}`);
  const message = typeof error?.message === 'string' ? error.message : '';
  const categories = /requests per day|\bRPD\b/i.test(message) ? 'requests/day'
    : /tokens per min|\bTPM\b/i.test(message) ? 'tokens/minute'
    : /requests per min|\bRPM\b/i.test(message) ? 'requests/minute' : '';
  if (categories) details.push(`limit=${categories}`);
  for (const kind of ['requests','tokens','project-tokens']) {
    const remaining = headers[`x-ratelimit-remaining-${kind}`], limit = headers[`x-ratelimit-limit-${kind}`];
    const reset = headers[`x-ratelimit-reset-${kind}`];
    if (reset && /^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/.test(reset)) details.push(`${kind} reset=${reset}`);
    if (remaining !== undefined && /^\d+$/.test(remaining)) details.push(`${kind} remaining=${remaining}${limit && /^\d+$/.test(limit) ? `/${limit}` : ''}`);
  }
  const cap = /\bLimit\s*:?\s*(\d+(?:\.\d+)?)/i.exec(message)?.[1];
  const requested = /\bRequested\s*:?\s*(\d+(?:\.\d+)?)/i.exec(message)?.[1];
  if (categories && cap) details.push(`cap=${cap}`);
  const used = /\bUsed\s*:?\s*(\d+(?:\.\d+)?)/i.exec(message)?.[1];
  if (categories && used) details.push(`used=${used}`);
  if (categories && requested) details.push(`requested=${requested}`);
  return details.length ? ` Limit details: ${details.join('; ')}.` : '';
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Request canceled')); return; }
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('Request canceled')); };
    signal?.addEventListener('abort', abort, {once:true});
  });
}

/** Retry only explicit rate-limit responses, before any local write or tool execution. */
export async function requestLlm(url: string, headers: Record<string, string>, body: string, transport: Transport, timeoutMs: number, feedback: RetryFeedback = {}): Promise<LlmHttpResponse> {
  const deadline = Date.now() + timeoutMs;
  const check = () => { if (feedback.signal?.aborted || feedback.cancelled?.()) throw new Error('Chat was closed or cleared; no tasks were written.'); };
  for (let attempt = 0; attempt < 3; attempt++) {
    check();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('LLM request timed out. No tasks were written.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    let response: LlmHttpResponse;
    try {
      response = await Promise.race([transport(url, headers, body), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timeout')), remaining);
      }), new Promise<never>((_, reject) => {
        abort = () => reject(new Error('Request canceled'));
        feedback.signal?.addEventListener('abort', abort, {once:true});
        if (feedback.signal?.aborted) abort();
      })]);
    } catch {
      check();
      throw new Error('LLM request failed or timed out. Check your network and provider settings. No tasks were written.');
    } finally { if (timer) clearTimeout(timer); if (abort) feedback.signal?.removeEventListener('abort', abort); }
    check();
    if (response.status >= 200 && response.status < 300) return response;
    if (response.status === 429) {
      if (quotaExhausted(response.json)) throw new Error('LLM returned HTTP 429: provider quota or credit balance exhausted. Check billing/usage with your provider, or select another configured provider/model. Automatic retries will not resolve this. No tasks were written.');
      const delay = retryDelay(response, attempt + 1);
      const details = rateLimitDetails(response) + ` Request payload=${body.length} characters (not a token count).`;
      if (attempt === 2) throw new Error(`LLM returned HTTP 429: still rate-limited after 3 attempts.${details} Check the selected model/project rate limits or select another configured model. No tasks were written.`);
      if (delay > 30000 || delay >= deadline - Date.now()) throw new Error(`LLM returned HTTP 429: provider Retry-After is ${Math.ceil(delay / 1000)} seconds, outside the automatic retry budget.${details} This can be a model/project request or token limit even with a valid key and available balance. Check API limits or select another configured model; automatic retry is deferred. No tasks were written.`);
      feedback.onRetry?.(delay, attempt + 1);
      try { await wait(delay, feedback.signal); } catch { check(); throw new Error('Request canceled'); }
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
