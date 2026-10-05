import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestLlm, retryDelay, rateLimitDetails } from '../src/llm-request';
const url = 'https://example.test/v1/responses';
afterEach(() => vi.useRealTimers());
describe('provider rate limits', () => {
  it('respects Retry-After, retries exactly the same body, then returns once', async () => {
    vi.useFakeTimers();
    const transport = vi.fn().mockResolvedValueOnce({status:429,json:{error:{code:'rate_limit_exceeded'}},headers:{'Retry-After':'2'}})
      .mockResolvedValueOnce({status:429,json:{},headers:{'retry-after-ms':'500'}}).mockResolvedValue({status:200,json:{ok:true}});
    const feedback = vi.fn();
    const result = requestLlm(url, {}, 'same body', transport, 60000, {onRetry:feedback});
    const checked = expect(result).resolves.toEqual({status:200,json:{ok:true}});
    await vi.advanceTimersByTimeAsync(1999); expect(transport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(transport).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500); await checked;
    expect(transport.mock.calls.every(c=>c[2]==='same body')).toBe(true);
    expect(feedback.mock.calls).toEqual([[2000,1],[500,2]]);
  });
  it.each(['insufficient_quota','billing_hard_limit_reached','insufficient_balance'])('does not retry exhausted quota %s or expose raw provider prose', async code => {
    const transport = vi.fn().mockResolvedValue({status:429,json:{error:{code,message:'private-token echoed'}}});
    const failure = await requestLlm(url, {}, '{}', transport, 60000).catch(e=>e.message);
    expect(failure).toContain('quota or credit balance'); expect(failure).not.toContain('private-token'); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('stops after three rate-limited attempts', async () => {
    vi.useFakeTimers();
    const transport = vi.fn().mockResolvedValue({status:429,json:{},headers:{'Retry-After':'1'}});
    const result = requestLlm(url,{},'{}',transport,60000);
    const checked = expect(result).rejects.toThrow('after 3 attempts');
    await vi.advanceTimersByTimeAsync(2000); await checked; expect(transport).toHaveBeenCalledTimes(3);
  });
  it('does not misclassify a daily request cap as exhausted credit', async () => {
    const transport=vi.fn().mockResolvedValue({status:429,headers:{'Retry-After':'15475'},json:{error:{code:'rate_limit_exceeded',message:'Daily limit exceeded for requests per day (RPD): Limit: 100'}}});
    const failure=await requestLlm(url,{},'{}',transport,60000).catch(e=>e.message);
    expect(failure).toContain('requests/day');expect(failure).toContain('15475 seconds');expect(failure).not.toContain('credit balance exhausted');
  });
  it('never retries earlier than a long provider wait or exceeds the time budget', async () => {
    const transport = vi.fn().mockResolvedValue({status:429,json:{},headers:{'Retry-After':'120'}});
    await expect(requestLlm(url,{},'{}',transport,60000)).rejects.toThrow('120 seconds'); expect(transport).toHaveBeenCalledTimes(1);
    transport.mockResolvedValue({status:429,json:{},headers:{'Retry-After':'2'}});
    await expect(requestLlm(url,{},'{}',transport,1000)).rejects.toThrow('retry budget'); expect(transport).toHaveBeenCalledTimes(2);
  });
  it('parses HTTP dates, Gemini RetryInfo and safe fallback delays', () => {
    expect(retryDelay({status:429,json:{},headers:{'Retry-After':'Sun, 04 Oct 2026 08:00:03 GMT'}},1,Date.UTC(2026,9,4,8))).toBe(3000);
    expect(retryDelay({status:429,json:{error:{details:[{'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'1.5s'}]}}},1)).toBe(1500);
    expect(retryDelay({status:429,json:{},headers:{'Retry-After':'bad'}},2)).toBeGreaterThanOrEqual(2000);
  });
  it('stops retries when the chat is closed', async () => {
    vi.useFakeTimers(); let closed = false;
    const transport = vi.fn().mockResolvedValue({status:429,json:{},headers:{'Retry-After':'1'}});
    const result = requestLlm(url,{},'{}',transport,60000,{cancelled:()=>closed});
    const checked = expect(result).rejects.toThrow('Chat was closed');
    await vi.advanceTimersByTimeAsync(1); closed=true; await vi.advanceTimersByTimeAsync(999); await checked;
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('does not retry authentication or ambiguous network failures', async () => {
    const transport = vi.fn().mockResolvedValue({status:401,json:{error:'private-token'}});
    await expect(requestLlm(url,{},'{}',transport,60000)).rejects.toThrow('Authentication rejected'); expect(transport).toHaveBeenCalledTimes(1);
    transport.mockRejectedValue(new Error('private-token'));
    await expect(requestLlm(url,{},'{}',transport,60000)).rejects.toThrow('network'); expect(transport).toHaveBeenCalledTimes(2);
  });
  it.each(['ENOTFOUND','ERR_PROXY_CONNECTION_FAILED','ECONNREFUSED','ETIMEDOUT','ERR_CERT_AUTHORITY_INVALID'])('reports only a safe network classification for %s', async code => {
    const transport=vi.fn().mockRejectedValue(new Error(`${code}: private-token https://private.example/key`));
    const failure=await requestLlm(url,{},'{}',transport,60000).catch(e=>e.message);
    expect(failure).toContain(code);expect(failure).not.toContain('private');expect(failure).not.toContain('response timed out');expect(transport).toHaveBeenCalledTimes(1);
  });
  it('distinguishes a local response deadline from an immediate network error without resending', async () => {
    vi.useFakeTimers();const transport=vi.fn().mockImplementation(()=>new Promise(()=>{}));
    const checked=expect(requestLlm(url,{},'{}',transport,60000)).rejects.toThrow('response timed out after 60 seconds');
    await vi.advanceTimersByTimeAsync(60000);await checked;expect(transport).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
  });
  it('uses the server clock for HTTP-date Retry-After instead of creating a four-hour wait', () => {
    expect(retryDelay({status:429,json:{},headers:{Date:'Sun, 04 Oct 2026 08:00:00 GMT','Retry-After':'Sun, 04 Oct 2026 08:00:02 GMT'}},1,Date.UTC(2026,9,4,3,42,5))).toBe(2000);
    // Numeric Retry-After is seconds, even when large: never silently reinterpret as ms.
    expect(retryDelay({status:429,json:{},headers:{'Retry-After':'15475'}},1)).toBe(15475000);
  });
  it('reports request/token limits without exposing org IDs, credentials or raw error prose', () => {
    const details=rateLimitDetails({status:429,headers:{'x-ratelimit-remaining-tokens':'0','x-ratelimit-limit-tokens':'5000'},json:{error:{code:'rate_limit_exceeded',message:'private-token org-private reached tokens per min (TPM): Limit: 5000, Requested: 7000'}}});
    expect(details).toContain('tokens/minute');expect(details).toContain('remaining=0/5000');expect(details).toContain('requested=7000');expect(details).not.toContain('private');
  });
  it('cancels a retry wait immediately and clears all timers', async () => {
    vi.useFakeTimers();const controller=new AbortController();
    const transport=vi.fn().mockResolvedValue({status:429,json:{},headers:{'Retry-After':'30'}});
    const result=requestLlm(url,{},'{}',transport,60000,{signal:controller.signal});
    const checked=expect(result).rejects.toThrow('cleared');
    await vi.advanceTimersByTimeAsync(1);controller.abort();await checked;
    expect(transport).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
  });
  it('captures OpenAI colon-free counters and reset durations without shortening Retry-After', () => {
    const response={status:429,headers:{'Retry-After':'12779','x-ratelimit-reset-tokens':'6m0s','x-ratelimit-remaining-tokens':'4859','x-ratelimit-limit-tokens':'100000'},json:{error:{code:'rate_limit_exceeded',message:'org-private tokens per min (TPM): Limit 100000, Used 95141, Requested 8037. private-token'}}};
    const details=rateLimitDetails(response);
    expect(details).toContain('used=95141');expect(details).toContain('requested=8037');expect(details).toContain('tokens reset=6m0s');expect(details).not.toContain('private');
    expect(retryDelay(response,1)).toBe(12779000);
  });
  it('cancels an in-flight host request even when the transport cannot abort', async () => {
    vi.useFakeTimers();const controller=new AbortController();
    const transport=vi.fn().mockImplementation(()=>new Promise(()=>{}));
    const result=requestLlm(url,{},'{}',transport,60000,{signal:controller.signal});
    const checked=expect(result).rejects.toThrow('cleared');controller.abort();await checked;
    expect(vi.getTimerCount()).toBe(0);
  });
});
