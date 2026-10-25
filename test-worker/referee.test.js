import {afterEach, expect, it, vi} from 'vitest';
import {judge, validateVerdict} from '../worker/referee.js';
import {DEFAULT_RULES} from '../worker/game.js';
afterEach(() => vi.unstubAllGlobals());
it('Secrets Storeから実行時にキーを取得してAIへ渡す', async () => {
  const get = vi.fn(async () => 'fake-secret-from-store');
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(options.headers.Authorization).toBe('Bearer fake-secret-from-store');
    return Response.json({output: [{content: [{type: 'output_text', text: JSON.stringify({accepted: true, violation: 'none', severity: 0, program: {mode: 'none', id: '', code: ''},
      title: '白がジョーカー', explanation: '白を好きな牌として使えます。', rules: {...DEFAULT_RULES, joker: '5z'}})}]}]});
  }));
  const result = await judge('白をジョーカーに', DEFAULT_RULES, {OPENAI_KEY_STORE: {get}});
  expect(get).toHaveBeenCalledOnce();
  expect(result.rules.joker).toBe('5z');
});
it('Secrets Storeのアクセス失敗を安全なメッセージへ変換する', async () => {
  const request = vi.fn();vi.stubGlobal('fetch', request);
  await expect(judge('逆回り', DEFAULT_RULES, {OPENAI_KEY_STORE: {get: async () => {throw new Error('private details');}}}))
    .rejects.toThrow('Secrets Storeの設定を確認');
  expect(request).not.toHaveBeenCalled();
});
it('入力・出力・トークン量を制限し、秘密やカウンタをAIに送らない', async () => {
  const request = vi.fn(async (_, init) => {
    const payload = JSON.parse(init.body);
    expect(payload.max_output_tokens).toBe(2400);
    expect(payload.store).toBe(false);
    expect(payload.input).not.toContain('private-counter');
    return new Response('x'.repeat(65537));
  });
  vi.stubGlobal('fetch', request);
  await expect(judge('提案', DEFAULT_RULES, {OPENAI_API_KEY: 'fake'}, [{id: 'a', title: '公開', code: '[]', memory: {'private-counter': 1}}]))
    .rejects.toThrow('AIの判定を適用できませんでした');
  request.mockClear();
  await expect(judge('a'.repeat(561), DEFAULT_RULES, {OPENAI_API_KEY: 'fake'})).rejects.toThrow('入力上限');
  expect(request).not.toHaveBeenCalled();
});
it('チョンボと採用の矛盾・不正な重大度を拒否する', () => {
  expect(() => validateVerdict({accepted: true, title: '', explanation: '', violation: 'malicious', severity: 2})).toThrow();
  expect(() => validateVerdict({accepted: false, title: '', explanation: '', violation: 'tokens', severity: 0})).toThrow();
});
