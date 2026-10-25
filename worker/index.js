import {DurableObject} from 'cloudflare:workers';
import {Room, GameError, require, randomInt, now} from './game.js';
import {judge, penalty, updatePrograms, VIOLATIONS, DEFAULT_MODEL} from './referee.js';

const ROOM_TTL = 6 * 3600;
const AI_TIMEOUT = 40;
const CODE = /^[A-HJ-NP-Z2-9]{5}$/;
const SECURITY = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
};
const json = (body, status = 200) => Response.json(body, {status, headers: SECURITY});
function failure(error) {
  return json({error: error instanceof GameError ? error.message : '処理に失敗しました。もう一度お試しください。'},
    error instanceof GameError ? error.status : 500);
}
const bearer = request => request.headers.get('Authorization')?.replace(/^Bearer /, '') || '';
const dailyLimit = env => Math.min(1000, Math.max(1, Number.parseInt(env.DAILY_AI_LIMIT, 10) || 100));
async function readBody(request) {
  require(request.headers.get('Content-Type')?.includes('application/json'), 'JSON形式で送信してください。', 415);
  require(request.body, '送信内容が空です。');
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 4096) { await reader.cancel(); throw new GameError('送信内容が大きすぎます。', 413); }
    chunks.push(value);
  }
  const buffer = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(buffer)); } catch { throw new GameError('送信内容が不正です。'); }
  require(body && typeof body === 'object' && !Array.isArray(body), '送信内容が不正です。');
  return body;
}
function checkOrigin(request) {
  const origin = request.headers.get('Origin');
  require(!origin || origin === new URL(request.url).origin, '別のサイトからは操作できません。', 403);
}
function roomStub(env, code) { return env.ROOMS.getByName(code); }
async function reserve(env, op, client = '') {
  const stub = env.LIMITS.getByName('global');
  const response = await stub.fetch('https://limits.internal/reserve', {
    method: 'POST', body: JSON.stringify({op, client}), headers: {'Content-Type': 'application/json'},
  });
  if (!response.ok) { const body = await response.json(); throw new GameError(body.error, response.status); }
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/api/health' && request.method === 'GET') {
        return json({ok: true, ai: Boolean(env.OPENAI_KEY_STORE || env.OPENAI_API_KEY), model: env.OPENAI_MODEL || DEFAULT_MODEL,
          transport: 'websocket', daily_ai_limit: dailyLimit(env)});
      }
      if (url.pathname === '/api/action' && request.method === 'POST') {
        checkOrigin(request);
        const body = await readBody(request);
        if (body.action === 'create') {
          require(typeof body.name === 'string' && [...body.name.trim()].length >= 1 && [...body.name.trim()].length <= 12,
            '名前を1〜12文字で入力してください。');
          // Hash the edge-provided IP; raw IP addresses are not stored.
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request.headers.get('CF-Connecting-IP') || 'local'));
          await reserve(env, 'create', [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join(''));
          for (let attempt = 0; attempt < 5; attempt++) {
            const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
            const code = Array.from({length: 5}, () => alphabet[randomInt(alphabet.length)]).join('');
            const response = await roomStub(env, code).fetch('https://room.internal/create', {
              method: 'POST', body: JSON.stringify({name: body.name, code}), headers: {'Content-Type': 'application/json'},
            });
            if (response.status !== 409) return response;
          }
          throw new GameError('部屋を作成できませんでした。もう一度お試しください。', 503);
        }
        require(typeof body.code === 'string', '部屋コードが不正です。');
        body.code = body.code.toUpperCase().trim();
        require(CODE.test(body.code), '部屋コードが不正です。');
        return await roomStub(env, body.code).fetch('https://room.internal/action', {
          method: 'POST', body: JSON.stringify(body), headers: {'Content-Type': 'application/json', Authorization: request.headers.get('Authorization') || ''},
        });
      }
      const match = url.pathname.match(/^\/api\/(state|ws)\/([A-HJ-NP-Z2-9]{5})$/);
      if (match && request.method === 'GET') {
        checkOrigin(request);
        const forwarded = new Request(`https://room.internal/${match[1]}`, request);
        return await roomStub(env, match[2]).fetch(forwarded);
      }
      if (url.pathname.startsWith('/api/')) return json({error: '操作が見つかりません。'}, 404);
      // Only public assets are ever served. No source tree, secrets, or SPA fallback.
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({error: '操作が見つかりません。'}, 405);
      if (!['/', '/app.js', '/style.css', '/favicon.svg'].includes(url.pathname)) return json({error: '見つかりません。'}, 404);
      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(SECURITY)) headers.set(key, value);
      return new Response(response.body, {status: response.status, headers});
    } catch (error) { return failure(error); }
  },
};

export class UsageLimits extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS usage_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
  }
  async fetch(request) {
    try {
      const body = await request.json(), day = new Date().toISOString().slice(0, 10);
      const row = this.ctx.storage.sql.exec('SELECT data FROM usage_state WHERE id = 1').toArray()[0];
      let usage = row ? JSON.parse(row.data) : null;
      if (!usage || usage.day !== day) usage = {day, ai: 0, rooms: 0, clients: {}};
      if (body.op === 'ai') {
        require(usage.ai < dailyLimit(this.env), '本日のAI判定の上限に達しました。明日また遊べます。', 429);
        usage.ai++;
      } else if (body.op === 'create') {
        require(usage.rooms < 100, '本日の部屋作成の上限に達しました。', 429);
        require(typeof body.client === 'string' && body.client.length === 64, '接続情報が不正です。');
        const previous = usage.clients[body.client];
        const bucket = previous && now() - previous.since < 60 ? previous : {since: now(), count: 0};
        require(bucket.count < 5, '部屋を作りすぎています。1分ほど待ってください。', 429);
        bucket.count++; usage.clients[body.client] = bucket; usage.rooms++;
      } else throw new GameError('操作が見つかりません。');
      // Read-modify-write is synchronous: no other event can consume the same slot.
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO usage_state VALUES (1, ?)', JSON.stringify(usage));
      await this.ctx.storage.setAlarm(Date.parse(day + 'T00:00:00Z') + 24 * 3600 * 1000);
      return json({ok: true});
    } catch (error) { return failure(error); }
  }
  async alarm() {
    const row = this.ctx.storage.sql.exec('SELECT data FROM usage_state WHERE id = 1').toArray()[0];
    const today = new Date().toISOString().slice(0, 10);
    if (row && JSON.parse(row.data).day !== today) this.ctx.storage.sql.exec('DELETE FROM usage_state');
    else if (row) await this.ctx.storage.setAlarm(Date.parse(today + 'T00:00:00Z') + 24 * 3600 * 1000);
  }
}

export class MahjongRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    this.queue = Promise.resolve();
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS room_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
      this.load();
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  load() {
    const row = this.ctx.storage.sql.exec('SELECT data FROM room_state WHERE id = 1').toArray()[0];
    this.room = row ? Room.restore(JSON.parse(row.data)) : null;
  }
  async serialized(callback) {
    const previous = this.queue;
    let release;
    this.queue = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await callback(); }
    catch (error) { this.load(); throw error; }
    finally { release(); }
  }
  connected() {
    return new Set(this.ctx.getWebSockets().filter(ws => ws.readyState === 1).map(ws => ws.deserializeAttachment()?.token));
  }
  snapshot(p) { return this.room.snapshot(p, this.connected()); }
  broadcast() {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== 1) continue;
      const p = this.room?.player(ws.deserializeAttachment()?.token);
      try {
        if (p) ws.send(JSON.stringify({state: this.snapshot(p)}));
        else ws.close(1008, '席がなくなりました。');
      } catch { /* A browser may disconnect while broadcasting. */ }
    }
  }
  async save() {
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO room_state VALUES (1, ?)', JSON.stringify(this.room));
    const times = [(this.room.touched + ROOM_TTL) * 1000];
    if (this.room.pending_job) times.push((this.room.pending_job.started + AI_TIMEOUT) * 1000);
    else if (this.room.status === 'playing') times.push((this.room.claim?.deadline ?? this.room.deadline) * 1000, this.room.npcDeadline() * 1000);
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, Math.min(...times)));
  }
  async publish() { await this.save(); this.broadcast(); }
  async fetch(request) {
    return this.serialized(async () => {
      try {
        const path = new URL(request.url).pathname;
        if (this.room && now() - this.room.touched >= ROOM_TTL) await this.expire();
        if (path === '/create') {
          require(!this.room, '部屋コードが使用中です。', 409);
          const body = await request.json();
          const room = new Room(body.code), p = room.join(body.name);
          this.room = room; await this.save();
          return json({token: p.token, state: this.snapshot(p)});
        }
        require(this.room, '部屋が見つかりません。コードを確認してください。', 404);
        if (path === '/action') {
          const data = await request.json();
          if (data.action === 'join') {
            const p = this.room.join(data.name); await this.publish();
            return json({token: p.token, state: this.snapshot(p)});
          }
          const p = this.room.player(bearer(request));
          require(p, '参加情報が無効です。部屋に入り直してください。', 403);
          p.seen = now(); this.room.tick();
          if (data.action === 'speech') {
            require(typeof data.text === 'string' && [...data.text.trim()].length >= 1 && [...data.text.trim()].length <= 280,
              '発言は1〜280文字で入力してください。');
            require(!this.room.pending, 'AI審判が考え中です。少し待ってください。');
            require(now() - p.last_speech >= 4, '発言は4秒あけてください。');
            const text = data.text.trim();
            if (this.room.status === 'playing') {
              require(this.env.OPENAI_KEY_STORE || this.env.OPENAI_API_KEY, 'AIキーが未設定です。部屋主にお知らせください。');
              require(this.room.ai_calls < 80, 'この部屋のAI判定は80回までです。');
              await reserve(this.env, 'ai');
            }
            if (this.room.speech(p, text, true)) {
              this.room.pending = true; this.room.ai_calls++;
              const job = {id: crypto.randomUUID(), started: now(), text, seat: this.room.players.indexOf(p), by: p.name, before: structuredClone(this.room.rules), programs: structuredClone(this.room.programs)};
              this.room.pending_job = job;
              await this.publish();
              this.ctx.waitUntil(this.runJudge(job));
              return json({state: this.snapshot(p)});
            }
          } else {
            const result = this.room.action(data.action, p, data);
            if (result.left) {
              if (!this.room.players.length) await this.expire();
              else await this.publish();
              return json({left: true});
            }
          }
          await this.publish();
          return json({state: this.snapshot(p)});
        }
        const protocols = (request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map(s => s.trim());
        const p = this.room.player(path === '/ws' ? protocols[1] : bearer(request));
        require(p, '参加情報が無効です。部屋に入り直してください。', 403);
        if (path === '/ws') {
          require(request.headers.get('Upgrade')?.toLowerCase() === 'websocket' && protocols[0] === 'ittamon', 'WebSocket接続が必要です。', 426);
          const sockets = this.ctx.getWebSockets().filter(ws => ws.readyState === 1);
          require(sockets.length < 12 && sockets.filter(ws => ws.deserializeAttachment()?.token === p.token).length < 3,
            '接続が多すぎます。別のタブを閉じてください。', 429);
          const pair = new WebSocketPair();
          this.ctx.acceptWebSocket(pair[1]);
          pair[1].serializeAttachment({token: p.token});
          p.seen = now(); this.room.tick(); this.room.version++;
          await this.publish();
          return new Response(null, {status: 101, webSocket: pair[0], headers: {'Sec-WebSocket-Protocol': 'ittamon'}});
        }
        require(path === '/state', '操作が見つかりません。', 404);
        if (this.room.tick()) await this.publish();
        return json({state: this.snapshot(p)});
      } catch (error) { this.load(); return failure(error); }
    });
  }
  async runJudge(job) {
    let result, error;
    try { result = await judge(job.text, job.before, this.env, job.programs || []); }
    catch (caught) { error = caught instanceof GameError ? caught.message : 'AI判定に失敗しました。'; }
    await this.serialized(async () => {
      if (this.room?.pending_job?.id !== job.id) return;
      if (result?.violation && result.violation !== 'none') {
        this.room.chonbo(job.seat, result.violation, penalty(result.violation, result.severity),
          `${VIOLATIONS[result.violation]}：${result.explanation}`);
      } else if (result) {
        // Validate the complete change before any speech effects or settings are applied.
        let programs;
        try { programs = updatePrograms(this.room.programs, result); }
        catch (caught) { error = `${caught instanceof GameError ? caught.message : '生成ルールを適用できませんでした。'}既存ルールを維持します。減点はありません。`; }
        if (!error) {
          if (result.accepted) {
            const changes = Object.fromEntries(Object.entries(result.rules).filter(([key, value]) => value !== job.before[key])
              .map(([key, value]) => [key, {before: job.before[key], after: value}]));
            // Preserve changes made by existing event programs unless the proposal changes that field.
            for (const key of Object.keys(changes)) this.room.rules[key] = result.rules[key];
            const programChanged = result.program.mode !== 'none';
            this.room.programs = programs;
            if (Object.keys(changes).length || programChanged) {
              this.room.history.push({title: result.title, explanation: result.explanation, changes, by: job.by,
                ...(programChanged ? {program: result.program} : {})});
              this.room.history = this.room.history.slice(-30);
              this.room.event('rule', result.explanation, {title: result.title, changes});
            } else this.room.event('judge', result.explanation);
            if (['add', 'replace'].includes(result.program.mode)) {
              this.room.applyAdoptedProgram(programs.find(p => p.id === result.program.id));
            }
          } else this.room.event('judge', result.explanation);
          // Install the verdict first, so the proposal itself uses the adopted rules.
          this.room.speechEffects(this.room.players[job.seat], job.text);
        }
      }
      if (error) this.room.event('error', error);
      this.resume(job);
      await this.publish();
    });
  }
  resume(job) {
    const elapsed = Math.max(0, now() - job.started);
    this.room.deadline += elapsed;
    this.room.npc_deadline += elapsed;
    if (this.room.status === 'playing' && this.room.claim) {
      this.room.claim.deadline += elapsed;
      if (!this.room.players.some((_, i) => this.room.canRon(i))) this.room.advance();
    } else if (this.room.status === 'playing' && this.room.pending_job?.reset_deadline) this.room.deadline = now() + this.room.turn_seconds;
    this.room.pending = false; this.room.pending_job = null;
  }
  async expire() {
    this.room = null;
    for (const ws of this.ctx.getWebSockets()) try { ws.close(1008, '部屋の有効期限が切れました。'); } catch { /* closed */ }
    this.ctx.storage.sql.exec('DELETE FROM room_state');
    await this.ctx.storage.deleteAlarm();
  }
  async alarm() {
    return this.serialized(async () => {
      if (!this.room) return;
      if (now() - this.room.touched >= ROOM_TTL) return this.expire();
      const job = this.room.pending_job;
      if (job && now() >= job.started + AI_TIMEOUT) {
        this.room.event('error', 'AI判定が中断されました。ルールを維持して再開します。');
        this.resume(job);
      } else this.room.tick();
      await this.publish();
    });
  }
  async webSocketClose(ws, code) {
    try { ws.close(code === 1006 ? 1000 : code, '接続終了'); } catch { /* already closed */ }
    return this.serialized(async () => {
      if (!this.room) return;
      this.room.version++; await this.publish();
    });
  }
  async webSocketError(ws) { return this.webSocketClose(ws, 1011); }
  async webSocketMessage(ws) {
    // Only the runtime's hibernation-friendly ping/pong is accepted.
    try { ws.close(1008, '操作はHTTP APIを利用してください。'); } catch { /* closed */ }
  }
}
