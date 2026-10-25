import {beforeEach, afterEach, describe, it, expect, vi} from 'vitest';
import {env} from 'cloudflare:workers';
import {SELF, reset, runInDurableObject, runDurableObjectAlarm, evictDurableObject} from 'cloudflare:test';
import {DEFAULT_RULES} from '../worker/game.js';

const origin = 'https://game.example';
const sockets = [];
const stubFor = code => env.ROOMS.getByName(code);
async function action(action, client, extra = {}) {
  const response = await SELF.fetch(origin + '/api/action', {method: 'POST',
    headers: {'Content-Type': 'application/json', Origin: origin, ...(client ? {Authorization: 'Bearer ' + client.token} : {})},
    body: JSON.stringify({action, code: client?.code, ...extra})});
  return {status: response.status, ...await response.json()};
}
async function create() {
  const result = await action('create', null, {name: 'ホスト'});
  expect(result.status).toBe(200);
  return {code: result.state.code, token: result.token};
}
async function state(client) {
  const response = await SELF.fetch(origin + '/api/state/' + client.code, {headers: {Authorization: 'Bearer ' + client.token}});
  return {status: response.status, ...await response.json()};
}
async function started() {
  const host = await create(), clients = [host];
  for (let i = 1; i < 4; i++) {
    const result = await action('join', null, {code: host.code, name: '人' + i});
    clients.push({code: host.code, token: result.token});
  }
  for (const client of clients) expect((await action('ready', client)).status).toBe(200);
  expect((await action('start', host)).status).toBe(200);
  return clients;
}
async function ws(client, customOrigin = origin) {
  const response = await SELF.fetch(origin + '/api/ws/' + client.code, {headers: {
    Upgrade: 'websocket', Origin: customOrigin, 'Sec-WebSocket-Protocol': 'ittamon, ' + client.token,
  }});
  if (response.status !== 101) return response;
  const socket = response.webSocket; socket.accept(); sockets.push(socket); return socket;
}
const message = socket => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('WebSocket state timed out')), 3000);
  socket.addEventListener('message', event => {clearTimeout(timer); resolve(event.data);}, {once: true});
});
async function seed(code, callback) { return runInDurableObject(stubFor(code), async (instance) => {callback(instance.room); await instance.save();}); }
async function settled(client) {
  for (let i = 0; i < 100; i++) {
    const result = await state(client);
    if (!result.state.pending) return result.state;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('AI did not finish');
}
beforeEach(async () => {await reset();});
afterEach(async () => {for (const socket of sockets.splice(0)) socket.close(1000);vi.unstubAllGlobals();await reset();});

describe('WorkersとSQLite Durable Objects', () => {
  it('HTTPSで4人が参加し、部屋を分離して認証する', async () => {
    const clients = await started(), other = await create();
    const first = await state(clients[0]);
    expect(first.state.players).toHaveLength(4);
    expect(first.state.players.every(p => !('token' in p) && !('hand' in p))).toBe(true);
    expect((await state({code: other.code, token: clients[0].token})).status).toBe(403);
    expect((await action('join', null, {code: clients[0].code, name: '5人目'})).status).toBe(400);
    expect((await state(other)).state.players).toHaveLength(1);
  });
  it('実際にインスタンスを破棄した後、同じ手牌と得点へ復元する', async () => {
    const clients = await started();
    await seed(clients[0].code, room => {room.players[0].score = 31400;});
    const before = (await state(clients[0])).state;
    await evictDurableObject(stubFor(clients[0].code));
    const after = (await state(clients[0])).state;
    expect(after.hand).toEqual(before.hand);
    expect(after.players[0].score).toBe(31400);
    expect(after.wall).toBe(before.wall);
  });
  it('WebSocketを休止しても切断せず、ping/pongと個別の手牌を届ける', async () => {
    const clients = await started();
    const a = await ws(clients[0]);
    const b = await ws(clients[1]);
    await evictDurableObject(stubFor(clients[0].code));
    const pong = message(a); a.send('ping'); expect(await pong).toBe('pong');
    const received = message(b);
    const hand = (await state(clients[0])).state.hand;
    await action('discard', clients[0], {tile: hand.at(-1)});
    const view = JSON.parse(await received).state;
    expect(view.me).toBe(1);
    expect(view.hand).toEqual((await state(clients[1])).state.hand);
    expect(view.players[0].river).toHaveLength(1);
  });
  it('アラームだけで時間切れ打牌を進める', async () => {
    const clients = await started();
    await seed(clients[0].code, room => {room.deadline = 0;});
    expect(await runDurableObjectAlarm(stubFor(clients[0].code))).toBe(true);
    expect((await state(clients[0])).state.players[0].river).toHaveLength(1);
  });
  it('受け付けたAI判定を反映し、1日全体の上限を部屋作り直しでも回避できない', async () => {
    const clients = await started();
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input, init) => {
      if (String(input) !== 'https://api.openai.com/v1/responses') return originalFetch(input, init);
      const payload = JSON.parse(init.body), current = JSON.parse(payload.input).current_rules;
      expect(payload.store).toBe(false);
      expect(init.headers.Authorization).toBe('Bearer test-only-not-a-real-key');
      return Promise.resolve(Response.json({output: [{content: [{type: 'output_text', text: JSON.stringify({accepted: true,
        title: '対子で逆回り', explanation: '対子1組であがり、逆回りです。', rules: {...current, win_condition: 'any_pair', reverse_order: true}})}]}]}));
    });
    for (let i = 0; i < 3; i++) {
      await seed(clients[0].code, room => {room.players[0].last_speech = 0;});
      expect((await action('speech', clients[0], {text: '対子であがり、逆回り'})).status).toBe(200);
      const changed = await settled(clients[0]);
      expect(changed.rules.win_condition).toBe('any_pair');
      expect(changed.rules.reverse_order).toBe(true);
    }
    const next = await started();
    expect((await action('speech', next[0], {text: '白をジョーカーに'})).status).toBe(429);
    expect((await state(next[0])).state.ai_calls).toBe(0);
    expect((await state(next[0])).state.messages.some(m => m.kind === 'speech')).toBe(false);
  });
  it('AI通信エラー時にルールを維持し時計を再開する', async () => {
    const clients = await started();
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('private error body', {status: 429})));
    await action('speech', clients[0], {text: '何か変えよう'});
    const result = await settled(clients[0]);
    expect(result.rules).toEqual(DEFAULT_RULES);
    expect(result.can_discard).toBe(true);
    expect(result.messages.at(-1).kind).toBe('error');
    expect(JSON.stringify(result)).not.toContain('private error body');
  });
  it('中断されたAI判定をアラームで復旧し、遅れて届いた結果は適用しない', async () => {
    const clients = await started();
    const job = {id: 'aborted', started: Date.now() / 1000 - 45, before: {...DEFAULT_RULES}};
    await seed(clients[0].code, room => {room.pending = true;room.pending_job = job;});
    await evictDurableObject(stubFor(clients[0].code));
    await runDurableObjectAlarm(stubFor(clients[0].code));
    const result = (await state(clients[0])).state;
    expect(result.pending).toBe(false);
    expect(result.rules).toEqual(DEFAULT_RULES);
    expect(result.messages.at(-1).kind).toBe('error');
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json({output: [{content: [{type: 'output_text', text: JSON.stringify({accepted: true,
      title: '遅い判定', explanation: 'もう無効です。', rules: {...DEFAULT_RULES, win_condition: 'any_pair'}})}]}]})));
    await runInDurableObject(stubFor(clients[0].code), instance => instance.runJudge({...job, text: '対子で勝つ', by: 'ホスト'}));
    expect((await state(clients[0])).state.rules).toEqual(DEFAULT_RULES);
  });
  it('不正Origin・認証のないWebSocket・秘密ファイルを拒否する', async () => {
    const client = await create();
    expect((await ws(client, 'https://evil.example')).status).toBe(403);
    expect((await ws({...client, token: 'invalid'})).status).toBe(403);
    for (const path of ['/apikey.local', '/worker/index.js', '/.dev.vars', '/NETWORK_DIAGNOSTICS.md']) {
      expect((await SELF.fetch(origin + path)).status).toBe(404);
    }
    const response = await SELF.fetch(origin + '/api/action', {method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'https://evil.example'}, body: '{}'});
    expect(response.status).toBe(403);
    const large = await SELF.fetch(origin + '/api/action', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: 'a'.repeat(5000)})});
    expect(large.status).toBe(413);
  });
  it('同時発言は1件だけをAI判定に送り、別の発言は副作用なく拒否する', async () => {
    const clients = await started();
    vi.stubGlobal('fetch', async () => {
      // Both the timer and Response belong to the calling DO's I/O context.
      await new Promise(resolve => setTimeout(resolve, 500));
      return Response.json({output: [{content: [{type: 'output_text', text: JSON.stringify({accepted: false,
        title: '現状維持', explanation: '変更なしです。', rules: {...DEFAULT_RULES}})}]}]});
    });
    const results = await Promise.all([action('speech', clients[0], {text: '逆回り'}), action('speech', clients[1], {text: '対子で勝ち'})]);
    expect(results.map(r => r.status).sort()).toEqual([200, 400]);
    expect((await state(clients[0])).state.ai_calls).toBe(1);
    expect((await state(clients[0])).state.messages.filter(m => m.kind === 'speech')).toHaveLength(1);
    await settled(clients[0]);
  });
  it('日次アラームの遅延で当日分のAI上限が消えない', async () => {
    const clients = await started(), limits = env.LIMITS.getByName('global');
    await runInDurableObject(limits, async (_, ctx) => {
      const usage = {day: new Date().toISOString().slice(0, 10), ai: 3, rooms: 1, clients: {}};
      ctx.storage.sql.exec('INSERT OR REPLACE INTO usage_state VALUES (1, ?)', JSON.stringify(usage));
      await ctx.storage.setAlarm(Date.now() + 60000);
    });
    await runDurableObjectAlarm(limits);
    expect((await action('speech', clients[0], {text: '逆回り'})).status).toBe(429);
  });
  it('期限切れの部屋をアラームで削除する', async () => {
    const client = await create();
    await seed(client.code, room => {room.touched = Date.now() / 1000 - 7 * 3600;});
    await runDurableObjectAlarm(stubFor(client.code));
    expect((await state(client)).status).toBe(404);
  });
});
