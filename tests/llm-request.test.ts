import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestLlm, retryDelay } from '../src/llm-request';
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
});
