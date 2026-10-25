import {compile, execute} from './rule-program.js';
import {chooseDiscard} from './npc.js';
// Pure game rules. No platform APIs beyond Web Crypto; all state is serializable.
export const TILES = [...'mps'].flatMap(s => Array.from({length: 9}, (_, i) => `${i + 1}${s}`))
  .concat(Array.from({length: 7}, (_, i) => `${i + 1}z`));
export const DEFAULT_RULES = Object.freeze({win_condition: 'standard', seven_pairs: true,
  joker: 'none', win_points: 6000, bonus_suit: 'none', bonus_points: 500,
  reverse_order: false, turn_seconds: 45, speech_keyword: '', speech_effect: 'bonus', speech_points: 300});
export const WIN_NAMES = {standard: '4面子＋1雀頭', any_pair: '対子が1組あればOK',
  two_pairs: '対子が2組あればOK', any_triplet: '刻子が1組あればOK', all_simples: '手牌がすべて2〜8の数牌'};
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

export function winning(hand, rules, melds = []) {
  if (hand.length !== 14 - melds.length * 3 || hand.some(t => !TILES.includes(t))) return false;
  const tiles = rules.win_condition === 'standard' ? hand : [...hand, ...melds.flatMap(m => m.tiles)];
  const counts = TILES.map(t => tiles.filter(x => x === t).length);
  const jokerIndex = TILES.indexOf(rules.joker);
  const wild = jokerIndex < 0 ? 0 : counts[jokerIndex];
  if (jokerIndex >= 0) counts[jokerIndex] = 0;
  const pairs = counts.reduce((sum, n) => sum + Math.floor(n / 2), 0);
  const singles = counts.reduce((sum, n) => sum + n % 2, 0);
  if (rules.win_condition === 'any_pair') return pairs > 0 || wild >= 2 || (wild > 0 && counts.some(Boolean));
  if (rules.win_condition === 'two_pairs') { const used = Math.min(wild, singles); return pairs + used + Math.floor((wild - used) / 2) >= 2; }
  if (rules.win_condition === 'any_triplet') return Math.max(...counts) + wild >= 3;
  if (rules.win_condition === 'all_simples') return counts.every((n, i) => !n || (i < 27 && i % 9 > 0 && i % 9 < 8));
  if (!melds.length && rules.seven_pairs && Math.max(...counts) <= 2 && singles <= wild &&
      counts.filter(Boolean).length + Math.floor((wild - singles) / 2) === 7) return true;
  const memo = new Map();
  const meldable = (c, w) => {
    const i = c.findIndex(Boolean);
    if (i < 0) return w % 3 === 0;
    const key = c.join(',') + ':' + w;
    if (memo.has(key)) return memo.get(key);
    const take = Math.min(3, c[i]);
    if (w >= 3 - take) {
      const rest = [...c]; rest[i] -= take;
      if (meldable(rest, w - (3 - take))) { memo.set(key, true); return true; }
    }
    if (i < 27) {
      const base = Math.floor(i / 9) * 9;
      for (let start = Math.max(base, i - 2); start <= Math.min(i, base + 6); start++) {
        const rest = [...c]; let missing = 0;
        for (let j = start; j < start + 3; j++) { if (rest[j]) rest[j]--; else missing++; }
        if (missing <= w && meldable(rest, w - missing)) { memo.set(key, true); return true; }
      }
    }
    memo.set(key, false); return false;
  };
  for (let i = 0; i < counts.length; i++) {
    if (!counts[i]) continue;
    const take = Math.min(2, counts[i]);
    if (wild >= 2 - take) {
      const rest = [...counts]; rest[i] -= take;
      if (meldable(rest, wild - (2 - take))) return true;
    }
  }
  return wild >= 2 && meldable(counts, wild - 2);
}

export function validateRules(rules) {
  require(rules && typeof rules === 'object' && !Array.isArray(rules) &&
    Object.keys(rules).length === Object.keys(DEFAULT_RULES).length &&
    Object.keys(DEFAULT_RULES).every(key => Object.hasOwn(rules, key)), 'ルールの形式が不正です。');
  for (const [key, values] of Object.entries({win_condition: Object.keys(WIN_NAMES), joker: ['none', ...TILES],
    bonus_suit: ['none', 'm', 'p', 's', 'z'], speech_effect: ['bonus', 'win']})) {
    require(values.includes(rules[key]), '未対応のルールです。');
  }
  for (const [key, lo, hi] of [['win_points', 1000, 24000], ['bonus_points', 100, 2000],
    ['turn_seconds', 15, 120], ['speech_points', 100, 3000]]) {
    require(Number.isInteger(rules[key]) && rules[key] >= lo && rules[key] <= hi, 'ルールの数値が範囲外です。');
  }
  for (const key of ['seven_pairs', 'reverse_order']) require(typeof rules[key] === 'boolean', 'ルールの値が不正です。');
  require(typeof rules.speech_keyword === 'string' && [...rules.speech_keyword].length <= 20, '合言葉は20文字以内です。');
}

export class Room {
  constructor(code) {
    Object.assign(this, {code, players: [], status: 'lobby', rules: {...DEFAULT_RULES}, history: [], messages: [], programs: [],
      pending: false, ai_calls: 0, round: 0, version: 0, wall: [], turn: 0, claim: null, deadline: 0, drawn: false,
      result: null, created: now(), touched: now(), pending_job: null, npc_deadline: 0});
  }
  static restore(data) { return Object.assign(new Room(data.code), {drawn: data.status === 'playing' && !data.claim}, data); }
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
    this.round++; this.status = 'playing'; this.result = this.claim = null;
    this.wall = Array.from({length: 4}, () => TILES).flat();
    for (let i = this.wall.length - 1; i > 0; i--) { const j = randomInt(i + 1); [this.wall[i], this.wall[j]] = [this.wall[j], this.wall[i]]; }
    this.turn = (this.round - 1) % 4;
    for (const q of this.players) { q.hand = []; q.river = []; q.melds = []; }
    this.allPrograms('before_round_start');
    for (let i = 0; i < this.players.length; i++) {
      this.applyPrograms('before_deal', i);
      this.players[i].hand = sortedHand(Array.from({length: 13}, () => this.wall.pop()));
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
      this.event('result', this.result.text); return;
    }
    const tile = this.wall.pop();
    this.players[this.turn].hand.push(tile); this.drawn = true; this.deadline = now() + this.rules.turn_seconds;
    this.npc_deadline = now() + 1.2;
    this.applyPrograms('after_draw', this.turn, {tile});
  }
  canRon(i, readOnly = false) {
    return Boolean(this.claim && i !== this.claim.from && !this.claim.passed.includes(i) && !this.claim.requests?.some(r => r.seat === i) &&
      this.isWinning(i, [...this.players[i].hand, this.claim.tile], this.claim.tile, readOnly));
  }
  discard(p, tile) {
    require(this.status === 'playing' && !this.pending, 'いまは打牌できません。');
    require(!this.claim && p === this.players[this.turn], 'あなたの打牌順ではありません。');
    require(typeof tile === 'string' && p.hand.includes(tile), 'その牌は手牌にありません。');
    this.applyPrograms('before_discard', this.turn, {tile});
    this.drawn = false;
    p.hand.splice(p.hand.indexOf(tile), 1); p.hand = sortedHand(p.hand); p.river.push(tile);
    this.claim = {tile, from: this.turn, passed: [], requests: [], deadline: now() + 8};
    this.npc_deadline = now() + 1.2;
    this.event('discard', `${p.name} が打牌。`, {tile, seat: this.turn});
    this.applyPrograms('after_discard', this.turn, {tile});
    this.resolveClaim();
  }
  nextSeat(from) { return (from + (this.rules.reverse_order ? 3 : 1)) % 4; }
  changeTurn(seat) {
    this.applyPrograms('before_turn', seat);
    this.turn = seat;
    this.applyPrograms('after_turn', seat);
    this.deadline = now() + this.rules.turn_seconds;
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
    return options;
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
    const distance = seat => this.rules.reverse_order ? (claim.from - seat + 4) % 4 : (seat - claim.from + 4) % 4;
    const request = [...(claim.requests || [])].sort((a, b) =>
      Number(a.type === 'chi') - Number(b.type === 'chi') || distance(a.seat) - distance(b.seat))[0];
    if (!request) { this.advance(); return; }
    const p = this.players[request.seat], extra = {tile: claim.tile, call_type: request.type, source: claim.from};
    this.applyPrograms('before_call', request.seat, extra);
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
      this.finish(i, this.claim.from, [...p.hand, this.claim.tile], 'ロン');
    } else {
      require(!this.claim && this.drawn && i === this.turn && this.isWinning(i, p.hand), 'ツモあがりできる手牌ではありません。');
      this.finish(i, null, p.hand, 'ツモ');
    }
  }
  finish(winner, loser, hand, label) {
    hand = [...hand, ...(this.players[winner].melds || []).flatMap(m => m.tiles)];
    const extra = {hand, loser: loser ?? -1, method: label};
    const correction = (event, points) => this.programEffects(event, winner, {...extra, points}).reduce((sum, e) => sum + e.bonus, 0);
    const base = this.rules.win_points + correction('before_score', this.rules.win_points);
    const bonus = hand.filter(t => t[1] === this.rules.bonus_suit).length * this.rules.bonus_points;
    const clamp = n => Math.max(1000, Math.min(60000, n));
    let points = clamp(base + bonus + correction('win_score', base + bonus));
    points = clamp(points + correction('after_score', points));
    const deltas = [0, 0, 0, 0];
    if (loser === null) { const share = Math.ceil(points / 300) * 100; deltas.fill(-share); deltas[winner] = share * 3; }
    else { deltas[winner] = points; deltas[loser] = -points; }
    this.players.forEach((p, i) => { p.score += deltas[i]; });
    this.status = 'finished'; this.claim = null;
    this.result = {winner, text: `${this.players[winner].name} の${label}！ +${deltas[winner].toLocaleString('en-US')}点`, deltas, hand: sortedHand(hand)};
    this.event('result', this.result.text);
  }
  tick() {
    if (this.status !== 'playing' || this.pending) return false;
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
        else this.discard(p, chooseDiscard(p.hand, this.rules));
        return true;
      }
    }
    if (!this.claim && now() >= this.deadline) {
      const p = this.players[this.turn]; this.event('system', `${p.name} は時間切れでツモ切り。`); this.discard(p, p.hand.at(-1)); return true;
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
        this.rules = {...DEFAULT_RULES}; this.programs = [];
        this.history.push({title: '初期ルールに戻しました', explanation: '次の局から初期ルールで対戦します。', changes: {}, by: p.name});
        this.history = this.history.slice(-30); this.event('rule', '初期ルールに戻しました。'); break;
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
  programContext(i, extra = {}) {
    const p = this.players[i];
    return {actor: i, turn: this.turn, round: this.round, wall: this.wall.length, text: '', tile: '',
      meld_count: (p.melds || []).length, melds: (p.melds || []).flatMap(m => m.tiles),
      call_type: '', source: -1, points: 0, loser: -1, method: '',
      score: p.score, min_score: Math.min(...this.players.map(q => q.score)), max_score: Math.max(...this.players.map(q => q.score)),
      discard_count: this.players.reduce((n, q) => n + q.river.length, 0), hand_count: (extra.hand || p.hand).length,
      hand: [...(extra.hand || p.hand)], river: [...p.river], discards: this.players.flatMap(q => q.river), ...extra};
  }
  programEffects(event, i, extra = {}, readOnly = false) {
    const context = this.programContext(i, extra), effects = [];
    for (const program of this.programs) {
      if (program.disabled) continue;
      try {
        const effect = execute(compile(program.code), event, context, program.memory[i]);
        effects.push(effect);
        if (!readOnly) program.memory[i] = effect.memory;
      } catch {
        // A model's code bug is never a player's chonbo. Fail closed and continue play.
        if (!readOnly) {
          program.disabled = true;
          this.event('error', `生成ルール「${program.title}」を停止しました。実行上限または計算エラーです。減点はありません。`);
        }
      }
    }
    return effects;
  }
  isWinning(i, hand, tile = '', readOnly = false) {
    return winning(hand, this.rules, this.players[i].melds || []) || (hand.length === 14 - (this.players[i].melds || []).length * 3 && hand.every(t => TILES.includes(t)) &&
      this.programEffects('win_check', i, {hand, tile}, readOnly).some(e => e.win));
  }
  applyPrograms(event, i, extra = {}) {
    if (this.status !== 'playing') return;
    const effects = this.programEffects(event, i, extra);
    for (const effect of effects) {
      if (effect.award) {
        this.players.forEach((p, j) => { p.score += effect.award * (i === j ? 3 : -1); });
        this.event('system', `生成ルール発動：${this.players[i].name} ${effect.award > 0 ? 'が各員から' : 'が各員へ'}${Math.abs(effect.award)}点${effect.award > 0 ? '獲得' : '支払い'}。`);
      }
      if (effect.reverse) this.rules.reverse_order = !this.rules.reverse_order;
      if (effect.seconds !== null) {
        this.rules.turn_seconds = effect.seconds;
        if (!this.claim) {
          if (this.pending && this.pending_job) this.pending_job.reset_deadline = true;
          else this.deadline = now() + effect.seconds;
        }
      }
    }
    if (effects.some(e => e.win)) this.finish(i, null, this.players[i].hand, '生成ルールあがり');
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
      round: this.round, wall: this.wall.length, turn: this.turn, rules: this.rules,
      programs: this.programs.map(({id, title, explanation, code, disabled}) => ({id, title, explanation, code, disabled})),
      players: this.players.map(q => ({name: q.name, score: q.score, ready: q.ready, npc: Boolean(q.npc),
        online: Boolean(q.npc) || (connected ? connected.has(q.token) : now() - q.seen < 15), count: q.hand.length, river: q.river, melds: q.melds || []})),
      hand: p.hand, messages: this.messages, history: this.history.slice(-30), pending: this.pending,
      ai_calls: this.ai_calls, result: this.result, claim: this.claim ? {tile: this.claim.tile, from: this.claim.from, deadline: this.claim.deadline} : null,
      deadline: this.claim?.deadline ?? this.deadline, server_time: now(), can_discard: active && !this.claim && i === this.turn,
      call_options: active ? this.callOptions(i) : [], call_pending: Boolean(this.claim?.requests?.some(r => r.seat === i)),
      can_tsumo: active && this.drawn && !this.claim && i === this.turn && this.isWinning(i, p.hand, '', true), can_ron: active && this.canRon(i, true)});
  }
}
