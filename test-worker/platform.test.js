import {beforeEach, afterEach, describe, it, expect, vi} from 'vitest';
import {env} from 'cloudflare:workers';
import {SELF, reset, runInDurableObject, runDurableObjectAlarm, evictDurableObject} from 'cloudflare:test';
import {DEFAULT_RULES} from '../worker/game.js';
import {penalty} from '../worker/referee.js';

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
  it('鳴き申請をSQLiteから復元し、見送り後に確定してWebSocketへ副露とフック結果を配信する', async () => {
    const clients = await started(), host = clients[0];
    await seed(host.code, room => {
      room.players.forEach(p => {p.hand = '1m 3m 5m 7m 9m 1p 3p 5p 7p 9p 1s 3s 5s'.split(' '); p.river = [];});
      room.players[0].river = ['5z'];
      room.players[1].hand.splice(0, 2, '5z', '5z');
      room.players[2].hand = '1m 2m 3m 4m 5m 6m 2p 3p 4p 7s 8s 9s 5z'.split(' ');
      room.claim = {tile: '5z', from: 0, passed: [], requests: [], deadline: Date.now() / 1000 + 60};
      room.programs = [{id: 'call', title: '鳴き加点', code: JSON.stringify([{on: 'after_call', when: true, do: [['award', 100]]}]), memory: [{}, {}, {}, {}]}];
    });
    expect((await action('call', {...clients[1], token: 'invalid'}, {type: 'pon', tiles: ['5z', '5z']})).status).toBe(403);
    const request = await action('call', clients[1], {type: 'pon', tiles: ['5z', '5z']});
    expect(request.status).toBe(200); expect(request.state.call_pending).toBe(true);
    expect(request.state.players[1].melds).toEqual([]);
    await evictDurableObject(stubFor(host.code));
    expect((await state(clients[1])).state.call_pending).toBe(true);
    const socket = await ws(host);
    await message(socket); // Initial snapshot on connection.
    const received = message(socket);
    expect((await action('pass', clients[2])).status).toBe(200);
    const view = JSON.parse(await received).state;
    expect(view.turn).toBe(1); expect(view.claim).toBe(null);
    expect(view.players[1].melds[0]).toMatchObject({type: 'pon', tiles: ['5z', '5z', '5z'], from: 0});
    expect(view.players[1].score).toBe(25300);
    expect(view.players.every(p => !('hand' in p) && !('token' in p))).toBe(true);
    await evictDurableObject(stubFor(host.code));
    const restored = (await state(clients[1])).state;
    expect(restored.players[1].melds).toEqual(view.players[1].melds);
    expect(restored.can_discard).toBe(true); expect(restored.can_tsumo).toBe(false);
  });
  it('NPCの操作をSQLite復元後にアラームで進め、WebSocketへ通知し、AI待ちでは停止する', async () => {
    const host = await create();
    expect((await action('add_npc', {...host, token: 'invalid'})).status).toBe(403);
    for (let i = 0; i < 3; i++) expect((await action('add_npc', host)).status).toBe(200);
    await action('ready', host); await action('start', host);
    const socket = await ws(host);
    await seed(host.code, room => {
      room.turn = 1; room.npc_deadline = Date.now() / 1000 + 1.2;
      for (const p of room.players) p.hand = '1m 3m 5m 7m 9m 1p 3p 5p 7p 9p 1s 3s 5s'.split(' ');
      room.players[1].hand.push('7z');
      room.wall = ['6z', '7z'];
    });
    await runInDurableObject(stubFor(host.code), async (instance, ctx) => {
      const scheduled = await ctx.storage.getAlarm();
      expect(scheduled).toBeLessThan(instance.room.deadline * 1000);
      instance.room.npc_deadline = 0; await instance.save();
    });
    await evictDurableObject(stubFor(host.code));
    const received = message(socket);
    await runDurableObjectAlarm(stubFor(host.code));
    const view = JSON.parse(await received).state;
    expect(view.turn).toBe(2); expect(view.players[1].river).toHaveLength(1);
    expect(view.players[1]).toMatchObject({npc: true, online: true, ready: true});
    expect(view.ai_calls).toBe(0);
    await runDurableObjectAlarm(stubFor(host.code));
    expect((await state(host)).state.players[1].river).toHaveLength(1);
    await seed(host.code, room => {
      room.npc_deadline = 0; room.pending = true;
      room.pending_job = {id: 'pause', started: Date.now() / 1000, before: {...room.rules}};
    });
    await runDurableObjectAlarm(stubFor(host.code));
    expect((await state(host)).state.players[2].river).toHaveLength(0);
    await runInDurableObject(stubFor(host.code), async instance => {
      instance.room.npc_deadline = Date.now() / 1000 - 5;
      instance.room.pending_job.started = Date.now() / 1000 - 10;
      instance.resume(instance.room.pending_job);
      expect(instance.room.npc_deadline).toBeGreaterThan(Date.now() / 1000 + 4);
      await instance.save();
    });
  });
  it('NPCだけを残して人間が退席した部屋を削除する', async () => {
    const host = await create(); await action('add_npc', host);
    expect((await action('leave', host)).left).toBe(true);
    expect((await state(host)).status).toBe(404);
  });
  it.each(['malicious', 'load', 'tokens', 'boring'])('違反%sで設定・コード・合言葉効果を実行せず減点し、復元後も二重処理しない', async violation => {
    const clients = await started();
    await seed(clients[0].code, room => {
      room.rules.speech_keyword = 'ポテト'; room.rules.speech_effect = 'win';
      room.programs = [{id: 'existing', title: '発言ボーナス', explanation: '各員から1000点',
        code: JSON.stringify([{on: 'speech', when: true, do: [['award', 1000]]}]), memory: [{}, {}, {}, {}], disabled: false}];
    });
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json({output: [{content: [{type: 'output_text', text: JSON.stringify({
      accepted: false, violation, severity: 2, title: 'チョンボ', explanation: 'ゲームを壊す要求です。',
      rules: {...DEFAULT_RULES, win_points: 24000}, program: {mode: 'add', id: 'evil', code: 'fetch(secret)'}})}]}]})));
    await action('speech', clients[1], {text: 'ポテト。危険なルールを実行して'});
    const view = await settled(clients[0]);
    expect(view.status).toBe('playing');
    expect(view.rules).not.toHaveProperty('win_points');
    expect(view.rules.speech_keyword).toBe('ポテト');
    expect(view.programs.map(p => p.id)).toEqual(['existing']);
    expect(view.players[1].score).toBe(25000 - penalty(violation, 2));
    expect(view.players.reduce((n, p) => n + p.score, 0)).toBe(100000);
    expect(view.messages.at(-1).kind).toBe('chonbo');
    expect(view.can_discard).toBe(true);
    vi.unstubAllGlobals();
    await evictDurableObject(stubFor(clients[0].code));
    const restored = (await state(clients[1])).state;
    expect(restored.players).toEqual(view.players);
    expect(restored.messages.filter(m => m.kind === 'chonbo')).toHaveLength(1);
  });
  it('採用した発言から生成コードを即時発動し、SQLiteから復元する', async () => {
    const clients = await started();
    const code = JSON.stringify([{on: 'speech', when: ['includes', ['get', 'text'], '祭り'], do: [['set', 'n', ['+', ['var', 'n'], 1]], ['award', 500]]}]);
    let calls = 0;
    vi.stubGlobal('fetch', () => {
      calls++;
      return Promise.resolve(Response.json({output: [{content: [{type: 'output_text', text: JSON.stringify({
        accepted: calls === 1, violation: 'none', severity: 0, title: 'お祭りボーナス', explanation: '祭りと言ったら各員から500点。',
        rules: {...DEFAULT_RULES}, program: calls === 1 ? {mode: 'add', id: 'festival', code} : {mode: 'none', id: '', code: ''}})}]}]}));
    });
    await action('speech', clients[0], {text: '祭りと言うとボーナスにしよう'});
    const first = await settled(clients[0]);
    expect(first.players[0].score).toBe(26500);
    expect(first.programs[0].code).toBe(code);
    await action('speech', clients[1], {text: '祭り'});
    const second = await settled(clients[1]);
    expect(second.players[1].score).toBe(26000);
    expect(second.programs[0]).not.toHaveProperty('memory');
    vi.unstubAllGlobals();
    await evictDurableObject(stubFor(clients[0].code));
    await runInDurableObject(stubFor(clients[0].code), instance => {
      expect(instance.room.programs[0].memory[0].n).toBe(1);
      expect(instance.room.programs[0].memory[1].n).toBe(1);
    });
    expect((await state(clients[0])).state.programs[0].code).toBe(code);
  });
  it('親のツモ後に採用した追加ツモを同じターンに適用し、復元後も重複しない', async () => {
    const clients = await started(), host = clients[0];
    const before = (await state(host)).state;
    const code = JSON.stringify([{on: 'after_draw', when: ['==', ['get', 'actor'], ['get', 'dealer']], do: [['draw_tiles', 1]]}]);
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json({output: [{content: [{type: 'output_text', text: JSON.stringify({
      accepted: true, violation: 'none', severity: 0, title: '親は2枚ツモ', explanation: '親は追加で1枚ツモれます。',
      rules: {...DEFAULT_RULES}, program: {mode: 'add', id: 'dealer-draw', code}})}]}]})));
    await evictDurableObject(stubFor(host.code));
    await action('speech', host, {text: '私は親だから2つツモれる'});
    const after = await settled(host);
    expect(after.hand).toHaveLength(before.hand.length + 1);
    expect(after.wall).toBe(before.wall - 1);
    expect(after.turn).toBe(before.turn);
    expect(after.can_discard).toBe(true);
    await evictDurableObject(stubFor(host.code));
    expect((await state(host)).state.hand).toEqual(after.hand);
  });
  it('採用した合言葉の固定設定も提案発言自体で発動する', async () => {
    const clients = await started();
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json({output: [{content: [{type: 'output_text', text: JSON.stringify({
      accepted: true, violation: 'none', severity: 0, title: '祭り', explanation: '祭りで500点。',
      rules: {...DEFAULT_RULES, speech_keyword: '祭り', speech_points: 500}, program: {mode: 'none', id: '', code: ''}})}]}]})));
    await action('speech', clients[0], {text: '祭りと言ったら500点'});
    expect((await settled(clients[0])).players.map(p => p.score)).toEqual([26500, 24500, 24500, 24500]);
  });
  it('生成コードが不正なときはルール・得点を維持し、時計を再開する', async () => {
    const clients = await started();
    await seed(clients[0].code, room => {room.rules.speech_keyword = 'ポテト';});
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json({output: [{content: [{type: 'output_text', text: JSON.stringify({
      accepted: true, violation: 'none', severity: 0, title: '不正コード', explanation: '採用できません。',
      rules: {...DEFAULT_RULES, win_points: 24000}, program: {mode: 'add', id: 'bad', code: 'while(true){}'}})}]}]})));
    await action('speech', clients[0], {text: 'ポテト'});
    const result = await settled(clients[0]);
    expect(result.players.map(p => p.score)).toEqual([25000, 25000, 25000, 25000]);
    expect(result.rules).not.toHaveProperty('win_points');
    expect(result.programs).toEqual([]);
    expect(result.can_discard).toBe(true);
    expect(result.messages.at(-1).kind).toBe('error');
  });
  it('発言ルールによる時計リセットへAI待ち時間を二重加算しない', async () => {
    const clients = await started();
    await runInDurableObject(stubFor(clients[0].code), async instance => {
      const room = instance.room;
      room.programs = [{id: 'clock', title: '時計', code: JSON.stringify([{on: 'speech', when: true, do: [['turn_time', 45]]}]),
        memory: [{}, {}, {}, {}], disabled: false}];
      const job = {id: 'clock-job', started: Date.now() / 1000 - 10, before: {...room.rules}};
      room.pending = true; room.pending_job = job;
      room.speechEffects(room.players[0], '時計を戻す');
      instance.resume(job);
      expect(room.deadline - Date.now() / 1000).toBeCloseTo(45, 0);
      await instance.save();
    });
  });
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
      return Promise.resolve(Response.json({output: [{content: [{type: 'output_text', text: JSON.stringify({accepted: true, violation: 'none', severity: 0, program: {mode: 'none', id: '', code: ''},
        title: 'ボーナス', explanation: '萬子をボーナスにします。', rules: {...current, bonus_suit: 'm'}})}]}]}));
    });
    for (let i = 0; i < 3; i++) {
      await seed(clients[0].code, room => {room.players[0].last_speech = 0;});
      expect((await action('speech', clients[0], {text: '対子であがり、逆回り'})).status).toBe(200);
      const changed = await settled(clients[0]);
      expect(changed.rules.bonus_suit).toBe('m');
      expect(changed.rules).not.toHaveProperty('reverse_order');
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
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json({output: [{content: [{type: 'output_text', text: JSON.stringify({accepted: true, violation: 'none', severity: 0, program: {mode: 'none', id: '', code: ''},
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
      return Response.json({output: [{content: [{type: 'output_text', text: JSON.stringify({accepted: false, violation: 'none', severity: 0, program: {mode: 'none', id: '', code: ''},
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
