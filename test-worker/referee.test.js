import {afterEach, expect, it, vi} from 'vitest';
import {judge} from '../worker/referee.js';
import {DEFAULT_RULES} from '../worker/game.js';
afterEach(() => vi.unstubAllGlobals());
it('Secrets Storeから実行時にキーを取得してAIへ渡す', async () => {
  const get = vi.fn(async () => 'fake-secret-from-store');
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(options.headers.Authorization).toBe('Bearer fake-secret-from-store');
    return Response.json({output: [{content: [{type: 'output_text', text: JSON.stringify({accepted: true,
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
