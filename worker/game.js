import {compile, run, handles, validateTable, eventName, QUERIES, LIMITS} from './rule-program.js';
import {chooseDiscard} from './npc.js';
import {TILES, winning} from './hand.js';
// Pure game rules. No platform APIs beyond Web Crypto; all state is serializable.
export {TILES, winning} from './hand.js';
export const DEFAULT_RULES = Object.freeze({bonus_suit: 'none', bonus_points: 500,
  speech_keyword: '', speech_effect: 'bonus', speech_points: 300});
export const now = () => Date.now() / 1000;
export class GameError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function require(ok, message, status) { if (!ok) throw new GameError(message, status); }
export function randomInt(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const bytes = new Uint32Array(1);
  do { crypto.getRandomValues(bytes); } while (bytes[0] >= limit);
  return bytes[0] % max;
}
export function token() { return [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, '0')).join(''); }
export const sortedHand = hand => [...hand].sort((a, b) => TILES.indexOf(a) - TILES.indexOf(b));

export function validateRules(rules) {
  require(rules && typeof rules === 'object' && !Array.isArray(rules) &&
    Object.keys(rules).length === Object.keys(DEFAULT_RULES).length &&
    Object.keys(DEFAULT_RULES).every(key => Object.hasOwn(rules, key)), 'ルールの形式が不正です。');
  for (const [key, values] of Object.entries({bonus_suit: ['none', 'm', 'p', 's', 'z'], speech_effect: ['bonus', 'win']})) {
    require(values.includes(rules[key]), '未対応のルールです。');
  }
  for (const [key, lo, hi] of [['bonus_points', 100, 2000], ['speech_points', 100, 3000]]) {
    require(Number.isInteger(rules[key]) && rules[key] >= lo && rules[key] <= hi, 'ルールの数値が範囲外です。');
  }
  require(typeof rules.speech_keyword === 'string' && [...rules.speech_keyword].length <= 20, '合言葉は20文字以内です。');
}

export class Room {
  constructor(code) {
    Object.assign(this, {code, players: [], status: 'lobby', rules: {...DEFAULT_RULES}, history: [], messages: [], programs: [],
      direction: 1, turn_seconds: 45, pending: false, ai_calls: 0, round: 0, version: 0, wall: [], turn: 0, claim: null, deadline: 0, drawn: false,
      result: null, created: now(), touched: now(), pending_job: null, judge_queue: [], npc_deadline: 0, recent_events: []});
  }
  static restore(data) {
    const room = Object.assign(new Room(data.code), {drawn: data.status === 'playing' && !data.claim}, data);
    room.rules = Object.fromEntries(Object.entries(DEFAULT_RULES).map(([key, value]) => [key, data.rules?.[key] ?? value]));
    if (!Array.isArray(room.judge_queue)) room.judge_queue = [];
    // Programs from the retired JSON language cannot run; keep them visible but stopped.
    for (const program of room.programs) {
      if (!program.memory || Array.isArray(program.memory)) program.memory = {};
      try { compile(program.code); } catch { program.disabled = true; }
    }
    return room;
  }
  event(kind, text, extra = {}) {
    this.version++;
    this.touched = now();
    this.messages.push({id: this.version, kind, text, time: now(), ...extra});
    this.messages = this.messages.slice(-120);
  }
  join(name) {
    require(this.status === 'lobby', 'この部屋は対局中です。');
    require(this.players.length < 4, 'この部屋は満席です。');
    require(typeof name === 'string' && [...name.trim()].length >= 1 && [...name.trim()].length <= 12, '名前を1〜12文字で入力してください。');
    const p = {token: token(), name: name.trim(), score: 25000, hand: [], river: [], melds: [], ready: false, seen: now(), last_speech: 0};
    this.players.push(p); this.event('system', `${p.name} が着席しました。`); return p;
  }
  player(auth) {
    // Token size is public (64 hex characters); compare fixed-size buffers in constant time.
    const input = new TextEncoder().encode(typeof auth === 'string' ? auth : '');
    const padded = new Uint8Array(64); padded.set(input.subarray(0, 64));
    const match = this.players.find(p => crypto.subtle.timingSafeEqual(new TextEncoder().encode(p.token), padded));
    return input.length === 64 && !match?.npc ? match : undefined;
  }
  start(p) {
    require(p === this.players[0], '部屋主だけが開始できます。');
    require(this.status === 'lobby' || this.status === 'finished', 'すでに対局中です。');
    require(!this.pending, 'AIの判定を待ってください。');
    require(this.players.length === 4 && this.players.every(q => q.ready), '4人全員の準備完了を待ってください。');
    this.round++; this.status = 'playing'; this.result = this.claim = null; this.recent_events = [];
    this.wall = Array.from({length: 4}, () => TILES).flat();
    for (let i = this.wall.length - 1; i > 0; i--) { const j = randomInt(i + 1); [this.wall[i], this.wall[j]] = [this.wall[j], this.wall[i]]; }
    this.turn = (this.round - 1) % 4;
    for (const q of this.players) { q.hand = []; q.river = []; q.melds = []; }
    this.allPrograms('before_round_start');
    for (let i = 0; i < this.players.length; i++) {
      this.applyPrograms('before_deal', i);
      // Earlier deal hooks may already have given this seat extra tiles.
      this.players[i].hand = sortedHand([...this.players[i].hand, ...Array.from({length: 13}, () => this.wall.pop())]);
      this.applyPrograms('after_deal', i);
    }
    this.allPrograms('after_round_start');
    this.draw();
    this.event('system', `第${this.round}局、開局。言ったもん勝ち、はじめましょう。`);
  }
  allPrograms(event) { this.players.forEach((_, i) => this.applyPrograms(event, i)); }
  draw() {
    if (this.status !== 'playing') return;
    this.applyPrograms('before_draw', this.turn);
    if (!this.wall.length) {
      this.status = 'finished';
      this.result = {winner: null, text: '流局。山牌がなくなりました。', deltas: [0, 0, 0, 0], hand: []};
      this.event('result', this.result.text);
      this.runPrograms('after_round_end', this.turn, {winner: -1, loser: -1, method: '流局', deltas: [0, 0, 0, 0], drawn: true});
      return;
    }
    const tile = this.wall.pop();
    this.players[this.turn].hand.push(tile); this.drawn = true; this.deadline = now() + this.turn_seconds;
    this.npc_deadline = now() + 1.2;
    this.applyPrograms('after_draw', this.turn, {tile});
  }
  canRon(i, readOnly = false) {
    return Boolean(this.claim && i !== this.claim.from && !this.claim.passed.includes(i) && !this.claim.requests?.some(r => r.seat === i) &&
      this.isWinning(i, [...this.players[i].hand, this.claim.tile], this.claim.tile, readOnly, 'ロン'));
  }
  discard(p, tile) {
    require(this.status === 'playing' && !this.pending, 'いまは打牌できません。');
    require(!this.claim && p === this.players[this.turn], 'あなたの打牌順ではありません。');
    require(typeof tile === 'string' && p.hand.includes(tile), 'その牌は手牌にありません。');
    const blocked = this.discardBlock(this.turn, tile);
    // A rule that forbids every tile in hand is ignored for this turn.
    require(!blocked || !p.hand.some(t => !this.discardBlock(this.turn, t)), blocked);
    const seat = this.turn;
    this.applyPrograms('before_discard', seat, {tile});
    // The hook may have ended the round, moved the turn, or taken the tile away.
    if (this.status !== 'playing' || this.turn !== seat || this.claim) return;
    if (!p.hand.includes(tile)) { this.event('system', `生成ルールにより${p.name}の打牌は取り消されました。`); return; }
    this.drawn = false;
    p.hand.splice(p.hand.indexOf(tile), 1); p.hand = sortedHand(p.hand); p.river.push(tile);
    this.claim = {tile, from: this.turn, passed: [], requests: [], deadline: now() + 8};
    this.npc_deadline = now() + 1.2;
    this.event('discard', `${p.name} が打牌。`, {tile, seat: this.turn});
    this.applyPrograms('after_discard', this.turn, {tile});
    this.resolveClaim();
  }
  nextSeat(from) { return (from + (this.direction === -1 ? 3 : 1)) % 4; }
  changeTurn(seat) {
    this.applyPrograms('before_turn', seat);
    this.turn = seat;
    this.applyPrograms('after_turn', seat);
    this.deadline = now() + this.turn_seconds;
    this.npc_deadline = now() + 1.2;
  }
  advance() {
    if (this.status !== 'playing') return;
    this.claim = null; this.changeTurn(this.nextSeat(this.turn)); this.draw();
  }
  callOptions(i) {
    if (!this.claim || i === this.claim.from || this.claim.passed.includes(i) || this.claim.requests?.some(r => r.seat === i)) return [];
    const p = this.players[i], tile = this.claim.tile, options = [];
    if ((p.melds || []).length >= 4) return [];
    const count = p.hand.filter(t => t === tile).length;
    if (count >= 2) options.push({type: 'pon', tiles: [tile, tile]});
    if (count >= 3 && this.wall.length) options.push({type: 'kan', tiles: [tile, tile, tile]});
    if (i === this.nextSeat(this.claim.from) && tile[1] !== 'z') {
      const rank = Number(tile[0]);
      for (let start = Math.max(1, rank - 2); start <= Math.min(rank, 7); start++) {
        const tiles = [start, start + 1, start + 2].filter(n => n !== rank).map(n => `${n}${tile[1]}`);
        if (tiles.every(t => p.hand.includes(t))) options.push({type: 'chi', tiles});
      }
    }
    if (!this.programs.some(program => !program.disabled && handles(program.code, 'call_check'))) return options;
    return options.filter(o => this.runPrograms('call_check', i,
      {tile, tiles: [...o.tiles], callType: o.type, source: this.claim.from, allowed: true}, {readOnly: true})?.e.allowed !== false);
  }
  // Returns the reason a generated rule forbids discarding `tile`, or ''.
  discardBlock(i, tile) {
    const out = this.runPrograms('discard_check', i, {tile, hand: [...this.players[i].hand], allowed: true}, {readOnly: true});
    return out && out.e.allowed === false ? out.e.reason || 'その牌は生成ルールで打牌できません。' : '';
  }
  // Timeouts and NPCs keep to discard rules; the preferred tile goes first.
  allowedDiscard(i, preferred) {
    const hand = this.players[i].hand;
    return [preferred, ...[...hand].reverse()].find(t => !this.discardBlock(i, t)) ?? preferred;
  }
  call(p, type, tiles) {
    require(this.status === 'playing' && !this.pending, 'いまは鳴けません。');
    const i = this.players.indexOf(p);
    require(Array.isArray(tiles) && tiles.length >= 2 && tiles.length <= 3 && tiles.every(t => TILES.includes(t)), '鳴く牌を指定してください。');
    const option = this.callOptions(i).find(o => o.type === type && Array.isArray(tiles) &&
      sortedHand(o.tiles).join(',') === sortedHand(tiles).join(','));
    require(option, 'その鳴きはできません。');
    this.claim.requests ||= [];
    this.claim.requests.push({seat: i, ...option}); this.version++;
    this.resolveClaim();
  }
  resolveClaim(expired = false) {
    if (this.status !== 'playing' || !this.claim) return;
    if (!expired && this.players.some((_, i) => this.canRon(i) || this.callOptions(i).length)) return;
    const claim = this.claim;
    const distance = seat => this.direction === -1 ? (claim.from - seat + 4) % 4 : (seat - claim.from + 4) % 4;
    const request = [...(claim.requests || [])].sort((a, b) =>
      Number(a.type === 'chi') - Number(b.type === 'chi') || distance(a.seat) - distance(b.seat))[0];
    if (!request) { this.advance(); return; }
    const p = this.players[request.seat], extra = {tile: claim.tile, callType: request.type, source: claim.from, tiles: [...request.tiles]};
    this.applyPrograms('before_call', request.seat, extra);
    // Tile edits cancel the claim and advance play; then this call no longer applies.
    if (this.status !== 'playing' || this.claim !== claim) return;
    for (const tile of request.tiles) p.hand.splice(p.hand.indexOf(tile), 1);
    p.hand = sortedHand(p.hand); p.melds ||= [];
    p.melds.push({type: request.type, tiles: sortedHand([...request.tiles, claim.tile]), from: claim.from});
    this.players[claim.from].river.pop(); this.claim = null; this.drawn = false;
    this.event('call', `${p.name} が${{chi: 'チー', pon: 'ポン', kan: 'カン'}[request.type]}。`, {seat: request.seat, tile: claim.tile});
    this.applyPrograms('after_call', request.seat, extra);
    this.changeTurn(request.seat);
    if (request.type === 'kan') this.draw();
  }
  win(p, method) {
    require(this.status === 'playing' && !this.pending, 'いまはあがれません。');
    const i = this.players.indexOf(p);
    if (method === 'ron') {
      require(this.canRon(i), 'ロンできる手牌ではありません。');
      this.finish(i, this.claim.from, [...p.hand, this.claim.tile], 'ロン', this.claim.tile);
    } else {
      require(!this.claim && this.drawn && i === this.turn && this.isWinning(i, p.hand, p.hand.at(-1), false, 'ツモ'), 'ツモあがりできる手牌ではありません。');
      this.finish(i, null, p.hand, 'ツモ', p.hand.at(-1));
    }
  }
  finish(winner, loser, hand, label, tile = '') {
    hand = [...hand, ...(this.players[winner].melds || []).flatMap(m => m.tiles)];
    const info = {winner, loser: loser ?? -1, method: label, hand, tile};
    const limit = n => Math.max(0, Math.min(1000000, Math.round(n / 100) * 100));
    const stage = (event, points) => {
      const out = this.runPrograms(event, winner, {...info, points});
      const value = out ? out.e.points : points;
      return limit(typeof value === 'number' && Number.isFinite(value) ? value : points);
    };
    let points = stage('before_score', 6000);
    points += hand.filter(t => t[1] === this.rules.bonus_suit).length * this.rules.bonus_points;
    points = stage('after_score', stage('win_score', points));
    let deltas = [0, 0, 0, 0];
    if (loser === null) { const share = Math.ceil(points / 300) * 100; deltas.fill(-share); deltas[winner] = share * 3; }
    else { deltas[winner] = points; deltas[loser] = -points; }
    deltas = this.runPrograms('payment', winner, {...info, points, deltas})?.e.deltas ?? deltas;
    this.players.forEach((p, i) => { p.score += deltas[i]; });
    this.status = 'finished'; this.claim = null;
    const gain = deltas[winner];
    this.result = {winner, text: `${this.players[winner].name} の${label}！ ${gain >= 0 ? '+' : '−'}${Math.abs(gain).toLocaleString('en-US')}点`, deltas, hand: sortedHand(hand)};
    this.event('result', this.result.text);
    this.runPrograms('after_round_end', winner, {...info, points, deltas: [...deltas], drawn: false});
  }
  tick() {
    if (this.status !== 'playing' || this.pending) return false;
    if (!this.claim && !this.players[this.turn].hand.length) {
      this.event('system', `${this.players[this.turn].name} は手牌がないため打牌をスキップ。`);
      this.advance(); return true;
    }
    if (this.claim && now() >= this.claim.deadline) { this.resolveClaim(true); this.version++; return true; }
    if (now() >= this.npcDeadline()) {
      if (this.claim) {
        const winner = this.players.find((p, i) => p.npc && this.canRon(i));
        if (winner) { this.win(winner, 'ron'); return true; }
        for (let i = 0; i < this.players.length && this.claim; i++) {
          if (!this.players[i].npc || !this.callOptions(i).length) continue;
          const options = this.callOptions(i);
          const option = options.find(o => o.type === 'kan') || options.find(o => o.type === 'pon') || options[0];
          this.call(this.players[i], option.type, option.tiles);
        }
        return true;
      } else {
        const p = this.players[this.turn];
        if (this.drawn && this.isWinning(this.turn, p.hand)) this.win(p, 'tsumo');
        else this.discard(p, this.allowedDiscard(this.turn, chooseDiscard(p.hand, this.rules, t => !this.discardBlock(this.turn, t))));
        return true;
      }
    }
    if (!this.claim && now() >= this.deadline) {
      const p = this.players[this.turn]; this.event('system', `${p.name} は時間切れでツモ切り。`); this.discard(p, this.allowedDiscard(this.turn, p.hand.at(-1))); return true;
    }
    return false;
  }
  npcDeadline() {
    if (this.status !== 'playing' || this.pending) return Infinity;
    const eligible = this.claim ? this.players.some((p, i) => p.npc && (this.canRon(i, true) || this.callOptions(i).length)) : this.players[this.turn]?.npc;
    return eligible ? this.npc_deadline : Infinity;
  }
  action(action, p, data) {
    switch (action) {
      case 'add_npc': {
        require(p === this.players[0] && this.status === 'lobby', '部屋主が開局前にNPCを追加できます。');
        const names = ['NPC・白', 'NPC・發', 'NPC・中'];
        const name = names.find(name => !this.players.some(q => q.npc && q.name === name));
        const npc = this.join(name || 'NPC'); npc.npc = true; npc.ready = true;
        break;
      }
      case 'remove_npc':
        require(p === this.players[0] && this.status === 'lobby', '部屋主が開局前にNPCを外せます。');
        require(Number.isInteger(data.seat) && this.players[data.seat]?.npc, 'NPCの席を指定してください。');
        this.event('system', `${this.players[data.seat].name} が退席しました。`);
        this.players.splice(data.seat, 1); break;
      case 'ready': require(this.status === 'lobby', '準備を変更できません。'); p.ready = !p.ready; this.event('system', `${p.name}：${p.ready ? '準備完了！' : '準備中'}`); break;
      case 'start': this.start(p); break;
      case 'call': this.call(p, data.type, data.tiles); break;
      case 'discard': this.discard(p, data.tile); break;
      case 'tsumo': case 'ron': this.win(p, action); break;
      case 'pass': {
        const i = this.players.indexOf(p);
        require(this.status === 'playing' && !this.pending && (this.canRon(i) || this.callOptions(i).length), '見送るロン・鳴きがありません。');
        this.claim.passed.push(i); this.version++;
        this.resolveClaim(); break;
      }
      case 'reset_rules':
        require(p === this.players[0] && this.status !== 'playing' && !this.pending, '部屋主が局の合間にリセットできます。');
        this.rules = {...DEFAULT_RULES}; this.programs = []; this.direction = 1; this.turn_seconds = 45;
        this.history.push({title: '初期ルールに戻しました', explanation: '次の局から初期ルールで対戦します。', changes: {}, by: p.name});
        this.history = this.history.slice(-30); this.event('rule', '…卓を洗い直しました。次の局からは、まっさらな初期ルールでお楽しみください。'); break;
      case 'leave':
        require(this.status === 'lobby', '対局開始後は席を保持します。同じタブで復帰できます。');
        this.players.splice(this.players.indexOf(p), 1);
        // Lobby seats may move; always hand ownership to a human, or empty the room.
        if (this.players[0]?.npc) this.players = [...this.players.filter(q => !q.npc), ...this.players.filter(q => q.npc)];
        if (this.players.every(q => q.npc)) this.players = [];
        this.event('system', `${p.name} が退席しました。`); return {left: true};
      default: throw new GameError('操作が見つかりません。');
    }
    return {};
  }
  // Runs every active program for one event on a shared, mutable view of the table.
  // Each program's changes are validated and rolled back alone on failure.
  // Queries and read-only runs never change the room.
  runPrograms(event, i, extra = {}, {programs = this.programs, readOnly = false} = {}) {
    const name = eventName(event), query = QUERIES.includes(name), commit = !query && !readOnly;
    const active = programs.filter(program => !program.disabled && handles(program.code, name));
    if (!active.length) return null;
    const dealer = (this.round - 1 + 4) % 4, before = this.players.map(p => p.score);
    const data = () => JSON.stringify({players: g.players.map(({score, hand, river, melds}) => ({score, hand, river, melds})),
      wall: g.wall, direction: g.direction, turnSeconds: g.turnSeconds});
    const seat = value => {
      if (!Number.isInteger(value) || value < 0 || value >= this.players.length) throw new Error('席は0〜3の整数です。');
      return value;
    };
    const amount = value => {
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 10000000) throw new Error('点数が不正です。');
      return value;
    };
    let fx, g;
    const view = table => ({
      players: this.players.map((p, s) => ({seat: s, name: p.name, isDealer: s === dealer, ...structuredClone(table.players[s])})),
      wall: [...table.wall], direction: table.direction, turnSeconds: table.turnSeconds,
      turn: this.turn, dealer, round: this.round, claim: this.claim ? {tile: this.claim.tile, from: this.claim.from} : null,
    });
    const helpers = {
      draw: (s, count = 1) => {
        s = seat(s);
        if (!Number.isInteger(count) || count < 0 || count > LIMITS.pool) throw new Error('ツモ枚数が不正です。');
        const tiles = g.wall.splice(0, count); g.players[s].hand.push(...tiles); return tiles;
      },
      pay: (from, to, points) => { g.players[seat(from)].score -= amount(points); g.players[seat(to)].score += points; },
      award: (s, points) => { s = seat(s); amount(points); g.players.forEach((p, j) => { if (j !== s) { p.score -= points; g.players[s].score += points; } }); },
      win: (s, label = '生成ルールあがり') => { fx.wins.push({seat: seat(s), label: String(label).slice(0, 20) || '生成ルールあがり'}); },
      say: text => { if (fx.says.length < LIMITS.says) fx.says.push(String(text).slice(0, 100)); },
      random: n => randomInt(Math.max(1, Math.min(0x10000000, Math.floor(amount(n))))),
      shuffle: array => {
        if (!Array.isArray(array)) throw new Error('shuffleには配列を渡してください。');
        for (let k = array.length - 1; k > 0; k--) { const j = randomInt(k + 1); [array[k], array[j]] = [array[j], array[k]]; }
        return array;
      },
      next: s => (seat(s) + (g.direction === -1 ? 3 : 1)) % 4,
    };
    g = {...view({players: this.players.map(p => ({score: p.score, hand: p.hand, river: p.river, melds: p.melds || []})),
      wall: [...this.wall].reverse(), direction: this.direction, turnSeconds: this.turn_seconds}), ...helpers, memory: {}};
    const e = {type: name, actor: i, tile: '', text: '', callType: '', source: -1, tiles: [], winner: -1, loser: -1, method: '', ...structuredClone(extra)};
    // Later seats must still receive their normal 13-tile deal.
    const reserve = {before_round_start: 52, before_deal: (4 - i) * 13, after_deal: (3 - i) * 13}[name] || 0;
    const original = data(), wins = [], says = [];
    for (const program of active) {
      const saved = data(), savedEvent = structuredClone(e);
      fx = {wins: [], says: []};
      // A previous program may have replaced helpers or read-only fields.
      Object.assign(g, view(JSON.parse(saved)), helpers);
      g.memory = structuredClone(program.memory && !Array.isArray(program.memory) ? program.memory : {});
      try {
        for (const value of run(program.code, name, g, e)) {
          if (name === 'win_check' && typeof value === 'boolean') e.allowed = value;
          if (['discard_check', 'call_check'].includes(name) && (value === false || typeof value === 'string')) {
            e.allowed = false; if (typeof value === 'string' && value) e.reason = value.slice(0, 60);
          }
          if (['before_score', 'win_score', 'after_score'].includes(name) && typeof value === 'number') e.points = value;
          if (name === 'payment' && Array.isArray(value)) e.deltas = value;
        }
        if (name === 'payment' && !(Array.isArray(e.deltas) && e.deltas.length === 4 && e.deltas.every(n => typeof n === 'number' && Number.isFinite(n)))) {
          throw new Error('支払いの配列が不正です。');
        }
        validateTable(g, reserve);
        if (commit) program.memory = JSON.parse(JSON.stringify(g.memory ?? {}));
        wins.push(...fx.wins); says.push(...fx.says.map(text => `${program.title || '生成ルール'}：${text}`));
      } catch {
        // A model's code bug is never a player's chonbo. Fail closed and continue play.
        // Code may have replaced whole arrays or objects, so rebuild the view.
        Object.assign(g, view(JSON.parse(saved)), helpers);
        for (const key of Object.keys(e)) delete e[key];
        Object.assign(e, savedEvent);
        if (!readOnly) {
          program.disabled = true;
          this.event('error', `生成ルール「${program.title}」を停止しました。コードの実行エラーまたは上限超過です。減点はありません。`);
        }
      }
    }
    if (name === 'payment') e.deltas = e.deltas.map(n => Math.round(n));
    if (!commit) return {e, wins: [], says: [], tilesChanged: false, drew: false, secondsChanged: false};
    const drawSeat = name === 'after_call' ? i : this.turn, held = this.players[drawSeat]?.hand.length ?? 0;
    // Scores, direction and time are copied back separately; everything else is the table.
    const table = json => { const {players, wall} = JSON.parse(json); return JSON.stringify({wall, players: players.map(({score, ...rest}) => rest)}); };
    const tilesChanged = table(original) !== table(data());
    this.players.forEach((p, s) => {
      const v = g.players[s];
      if (tilesChanged) {
        p.hand = [...v.hand]; p.river = [...v.river];
        p.melds = v.melds.filter(m => m.tiles.length).map(m => ({type: m.type || 'exposed', tiles: [...m.tiles], from: Number.isInteger(m.from) ? m.from : s}));
      }
      p.score = Math.round(v.score);
    });
    if (tilesChanged) this.wall = [...g.wall].reverse();
    this.direction = g.direction;
    const seconds = Math.max(5, Math.min(300, Math.round(g.turnSeconds))), secondsChanged = seconds !== this.turn_seconds;
    this.turn_seconds = seconds;
    const drew = tilesChanged && (this.players[drawSeat]?.hand.length ?? 0) > held;
    const changed = this.players.map((p, s) => p.score - before[s]);
    if (changed.some(Boolean)) {
      this.event('system', `生成ルール発動：${this.players.map((p, s) => changed[s] ? `${p.name} ${changed[s] > 0 ? '+' : '−'}${Math.abs(changed[s]).toLocaleString('en-US')}` : '').filter(Boolean).join(' / ')}`);
    }
    if (tilesChanged) this.event('system', '生成ルール発動：牌を変更。');
    for (const text of says) this.event('system', text);
    return {e, wins, says, tilesChanged, drew, secondsChanged};
  }
  isWinning(i, hand, tile = '', readOnly = false, method = 'ツモ') {
    const melds = this.players[i].melds || [];
    // Every tsumo query sees the drawn tile, like the actual tsumo action.
    if (!tile && method === 'ツモ') tile = hand.at(-1) ?? '';
    if (hand.length !== 14 - melds.length * 3 || hand.some(t => !TILES.includes(t))) return false;
    const allowed = winning(hand, 'default', 'none', melds);
    const out = this.runPrograms('win_check', i, {hand: [...hand], tile, method, allowed,
      source: method === 'ロン' && this.claim ? this.claim.from : -1}, {readOnly});
    return out ? out.e.allowed === true : allowed;
  }
  applyPrograms(event, i, extra = {}, programs = this.programs, replay = false) {
    if (this.status !== 'playing') return;
    if (!replay && /^(before|after)_(draw|discard|call|turn)$/.test(event)) {
      this.recent_events.push({event, seat: i, extra: structuredClone(extra)});
      this.recent_events = this.recent_events.slice(-4);
    }
    const out = this.runPrograms(event, i, extra, {programs});
    if (!out) return;
    if (out.drew) this.drawn = true;
    if (out.secondsChanged && !this.claim) {
      if (this.pending && this.pending_job) this.pending_job.reset_deadline = true;
      else this.deadline = now() + this.turn_seconds;
    }
    const cancelledClaim = out.tilesChanged && this.claim;
    if (cancelledClaim) this.claim = null;
    const win = out.wins[0];
    if (win) this.finish(win.seat, null, this.players[win.seat].hand, win.label);
    else if (cancelledClaim) this.advance();
  }
  applyAdoptedProgram(program) {
    // Revisit at most two recent steps. Only the new code runs: normal draws,
    // discards, payments and pre-existing programs must never run twice.
    const events = [...this.recent_events];
    for (const {event, seat, extra} of events) {
      if (this.status !== 'playing') break;
      const turn = this.turn, claim = this.claim;
      this.applyPrograms(event, seat, extra, [program], true);
      // Tile edits during a claim can advance play. Later historical events
      // no longer describe that position; normal hooks handle the new step.
      if (this.turn !== turn || this.claim !== claim) break;
    }
  }
  chonbo(i, violation, points, explanation) {
    this.players.forEach((p, j) => { p.score += j === i ? -points : points / 3; });
    const deltas = this.players.map((_, j) => j === i ? -points : points / 3);
    this.event('chonbo', `${this.players[i].name}：−${points.toLocaleString('en-US')}点。${explanation}`, {seat: i, violation, points, deltas, title: 'チョンボ！'});
    this.history.push({title: 'チョンボ！', explanation, changes: {}, by: this.players[i].name, violation, points});
    this.history = this.history.slice(-30);
  }
  speech(p, text, defer = false) {
    p.last_speech = now();
    this.event('speech', text, {seat: this.players.indexOf(p), name: p.name});
    if (this.status !== 'playing') return false;
    if (!defer) this.speechEffects(p, text);
    return this.status === 'playing';
  }
  speechEffects(p, text) {
    if (this.status !== 'playing') return;
    const i = this.players.indexOf(p);
    this.applyPrograms('before_speech', i, {text});
    if (this.rules.speech_keyword && text.includes(this.rules.speech_keyword)) {
      if (this.rules.speech_effect === 'win') { this.finish(i, null, p.hand, '合言葉あがり'); return; }
      const points = this.rules.speech_points;
      this.players.forEach((q, j) => { q.score += points * (j === i ? 3 : -1); });
      this.event('system', `合言葉「${this.rules.speech_keyword}」発動！ ${p.name} が各員から${points.toLocaleString('en-US')}点ずつ獲得。`);
    }
    this.applyPrograms('after_speech', i, {text});
  }
  snapshot(p, connected) {
    const i = this.players.indexOf(p), active = this.status === 'playing' && !this.pending;
    return structuredClone({code: this.code, me: i, host: i === 0, status: this.status, version: this.version,
      round: this.round, wall: this.wall.length, turn: this.turn, direction: this.direction, turn_seconds: this.turn_seconds, rules: this.rules,
      programs: this.programs.map(({id, title, explanation, code, disabled}) => ({id, title, explanation, code, disabled})),
      players: this.players.map(q => ({name: q.name, score: q.score, ready: q.ready, npc: Boolean(q.npc),
        online: Boolean(q.npc) || (connected ? connected.has(q.token) : now() - q.seen < 15), count: q.hand.length, river: q.river, melds: q.melds || []})),
      hand: p.hand, messages: this.messages, history: this.history.slice(-30), pending: this.pending,
      judging: this.pending_job?.message ?? null, judge_queue: this.judge_queue.map(item => item.message),
      ai_calls: this.ai_calls, result: this.result, claim: this.claim ? {tile: this.claim.tile, from: this.claim.from, deadline: this.claim.deadline} : null,
      deadline: this.claim?.deadline ?? this.deadline, server_time: now(), can_discard: active && !this.claim && i === this.turn && p.hand.length > 0,
      call_options: active ? this.callOptions(i) : [], call_pending: Boolean(this.claim?.requests?.some(r => r.seat === i)),
      can_tsumo: active && this.drawn && !this.claim && i === this.turn && this.isWinning(i, p.hand, '', true), can_ron: active && this.canRon(i, true)});
  }
}
