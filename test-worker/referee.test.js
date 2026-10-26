import {afterEach, expect, it, vi} from 'vitest';
import {judge, validateVerdict} from '../worker/referee.js';
import {DEFAULT_RULES} from '../worker/game.js';
afterEach(() => vi.unstubAllGlobals());
it('Secrets Storeから実行時にキーを取得してAIへ渡す', async () => {
  const get = vi.fn(async () => 'fake-secret-from-store');
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(options.headers.Authorization).toBe('Bearer fake-secret-from-store');
    return Response.json({output: [{content: [{type: 'output_text', text: JSON.stringify({accepted: true, justification: 'sufficient', violation: 'none', severity: 0, program: {mode: 'add', id: 'joker', code: JSON.stringify([{on: 'win_check', when: true, do: [['allow_win', ['matches_hand', 'default', '5z']]]}])},
      title: '白がジョーカー', explanation: '白を好きな牌として使えます。', rules: {...DEFAULT_RULES}})}]}]});
  }));
  const result = await judge('白をジョーカーに', DEFAULT_RULES, {OPENAI_KEY_STORE: {get}});
  expect(get).toHaveBeenCalledOnce();
  expect(result.program.mode).toBe('add');
  expect(result.rules).not.toHaveProperty('joker');
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
    expect(payload.model).toBe('gpt-6-luna');
    expect(payload.reasoning).toEqual({effort: 'medium'});
    expect(payload.max_output_tokens).toBe(8192);
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
  expect(() => validateVerdict({accepted: true, justification: 'sufficient', title: '', explanation: '', violation: 'malicious', severity: 2})).toThrow();
  expect(() => validateVerdict({accepted: false, justification: 'not_needed', title: '', explanation: '', violation: 'tokens', severity: 0})).toThrow();
});
it('明示した旧モデルにはLuna専用の推論設定を送らない', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_, init) => {
    const payload = JSON.parse(init.body);
    expect(payload.model).toBe('gpt-4.1-mini');
    expect(payload).not.toHaveProperty('reasoning');
    expect(payload.max_output_tokens).toBe(2400);
    return new Response('', {status: 500});
  }));
  await expect(judge('提案', DEFAULT_RULES, {OPENAI_API_KEY: 'fake', OPENAI_MODEL: 'gpt-4.1-mini'})).rejects.toThrow('AIサービス');
});
it('推論でトークン上限に達した未完了の判定は適用しない', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({status: 'incomplete', incomplete_details: {reason: 'max_output_tokens'},
    output: [{type: 'reasoning', summary: []}, {content: [{type: 'output_text', text: JSON.stringify({accepted: true, justification: 'sufficient',
      title: '未完了', explanation: '', violation: 'none', severity: 0, program: {mode: 'none', id: '', code: ''}, rules: DEFAULT_RULES})}]}]})));
  await expect(judge('提案', DEFAULT_RULES, {OPENAI_API_KEY: 'fake'})).rejects.toThrow('適用できません');
});
it('推論ブロックを判定JSONと混ぜず、完成した出力だけを検証する', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({status: 'completed', output: [{type: 'reasoning', summary: []},
    {type: 'message', content: [{type: 'output_text', text: JSON.stringify({accepted: true, justification: 'sufficient',
      title: '対子', explanation: '対子1組であがれます。', violation: 'none', severity: 0, program: {mode: 'none', id: '', code: ''},
      rules: {...DEFAULT_RULES}})}]}]})));
  expect((await judge('提案', DEFAULT_RULES, {OPENAI_API_KEY: 'fake'})).title).toBe('対子');
});
it('廃止した6項目をAI出力スキーマとルール検証で受け付けない', async () => {
  const {SCHEMA, INSTRUCTIONS} = await import('../worker/referee.js');
  for (const [key, value] of Object.entries({win_condition: 'standard', seven_pairs: true, joker: 'none',
    win_points: 6000, reverse_order: false, turn_seconds: 45})) {
    expect(SCHEMA.properties.rules.properties).not.toHaveProperty(key);
    expect(() => validateVerdict({accepted: true, justification: 'sufficient', title: '変更', explanation: '', violation: 'none', severity: 0,
      program: {mode: 'none', id: '', code: ''}, rules: {...DEFAULT_RULES, [key]: value}})).toThrow();
  }
  expect(INSTRUCTIONS).toContain('固定設定がない');
});

it('正当化不足と採用の矛盾・判定漏れを拒否する', () => {
  const result = {accepted: true, justification: 'insufficient', title: '追加ツモ', explanation: '代償が足りません。',
    violation: 'none', severity: 0, rules: {...DEFAULT_RULES}, program: {mode: 'none', id: '', code: ''}};
  expect(() => validateVerdict(result)).toThrow('正当化判定');
  expect(() => validateVerdict({...result, justification: undefined})).toThrow('正当化判定');
  expect(validateVerdict({...result, accepted: false}).justification).toBe('insufficient');
});
