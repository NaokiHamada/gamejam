import Sval from 'sval';
import {TILES, winning} from './hand.js';
// Generated rules are plain JavaScript, interpreted by Sval because Workers forbid eval().
// The game is played among friends: the sandbox only bounds runaway CPU, not hostile code.
export const LIMITS = Object.freeze({programs: 8, chars: 6000, totalChars: 24000, steps: 200000, pool: 200, tiles: 1024, memory: 8000, says: 5});
const SIMPLE = ['round_start', 'deal', 'draw', 'discard', 'call', 'turn', 'speech', 'score', 'round_end'];
// Queries answer a question and never change the table.
export const QUERIES = Object.freeze(['win_check', 'discard_check', 'call_check']);
// A round only ends after the result; there is no before_round_end.
export const EVENTS = Object.freeze([...SIMPLE.flatMap(name => [`before_${name}`, `after_${name}`]).filter(name => name !== 'before_round_end'),
  'win_score', 'payment', ...QUERIES]);
// Short names mean the after_ event: on('draw') === on('after_draw').
const ALIASES = Object.fromEntries(SIMPLE.map(name => [name, `after_${name}`]));
export const eventName = event => ALIASES[event] || event;
const GUARD = '__rule_step__';

const loops = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);
const functions = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
// Every loop iteration and function call costs one step, so runaway code stops.
function instrument(node) {
  if (!node || typeof node.type !== 'string') return;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(instrument);
    else if (value && typeof value.type === 'string') instrument(value);
  }
  const step = {type: 'ExpressionStatement', expression: {type: 'CallExpression', callee: {type: 'Identifier', name: GUARD}, arguments: [], optional: false}};
  if (loops.has(node.type)) {
    node.body = node.body.type === 'BlockStatement' ? {...node.body, body: [step, ...node.body.body]} : {type: 'BlockStatement', body: [step, node.body]};
  } else if (functions.has(node.type)) {
    if (node.body.type === 'BlockStatement') node.body = {...node.body, body: [step, ...node.body.body]};
    else { node.body = {type: 'BlockStatement', body: [step, {type: 'ReturnStatement', argument: node.body}]}; node.expression = false; }
  }
}

const shared = {steps: 0};
function guard() { if (++shared.steps > LIMITS.steps) throw new Error('生成コードの実行量上限に達しました。'); }
const parse = tile => ({rank: Number(tile?.[0]) || 0, suit: tile?.[1] || ''});
// Helpers available to every program as globals.
const HELPERS = Object.freeze({
  TILES: Object.freeze([...TILES]),
  rank: tile => parse(tile).rank,
  suit: tile => parse(tile).suit,
  isHonor: tile => parse(tile).suit === 'z',
  isTerminal: tile => parse(tile).suit !== 'z' && [1, 9].includes(parse(tile).rank),
  sortTiles: tiles => [...tiles].sort((a, b) => TILES.indexOf(a) - TILES.indexOf(b)),
  countTile: (tiles, tile) => tiles.filter(t => t === tile).length,
  isWinningHand(tiles, options = {}) {
    const melds = options.melds || [], jokers = [].concat(options.joker || []).filter(t => TILES.includes(t));
    // Several joker kinds are folded into the first one.
    const hand = jokers.length > 1 ? tiles.map(t => jokers.includes(t) ? jokers[0] : t) : tiles;
    return winning(hand, options.shape || 'default', jokers[0] || 'none', melds);
  },
});

const cache = new Map();
export function compile(code) {
  if (typeof code !== 'string' || code.length > LIMITS.chars) throw new Error('生成コードが長すぎます。');
  if (cache.has(code)) return cache.get(code);
  const hooks = {};
  const on = (event, handler) => {
    const name = eventName(event);
    if (!EVENTS.includes(name)) throw new Error(`未対応のイベントです: ${event}`);
    if (typeof handler !== 'function') throw new Error('on()には関数を渡してください。');
    (hooks[name] ||= []).push(handler);
  };
  const interpreter = new Sval({ecmaVer: 'latest', sourceType: 'script', sandBox: true});
  interpreter.import({...HELPERS, on, [GUARD]: guard});
  const ast = interpreter.parse(code);
  instrument(ast);
  shared.steps = 0;
  interpreter.run(ast);
  if (!Object.keys(hooks).length) throw new Error('on()でイベントを1つ以上登録してください。');
  const program = {hooks};
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  cache.set(code, program);
  return program;
}
export function handles(code, event) {
  try { return Boolean(compile(code).hooks[eventName(event)]); } catch { return true; }
}

// Runs one program's handlers for an event against a mutable view `g`.
// Returns each handler's return value; throws on code errors or limits.
export function run(code, event, g, e) {
  const handlers = compile(code).hooks[eventName(event)] || [];
  const results = [];
  for (const handler of handlers) {
    shared.steps = 0;
    results.push(handler(g, e));
  }
  return results;
}

export function validateTable(g, reserve = 0) {
  if (!Array.isArray(g.players) || g.players.length !== 4 || !g.players.every(p => p && typeof p === 'object') || !Array.isArray(g.wall)) {
    throw new Error('卓の形式が不正です。');
  }
  const pools = [g.wall, ...g.players.flatMap(p => [p.hand, p.river, ...(Array.isArray(p.melds) ? p.melds.map(m => m?.tiles) : [null])])];
  if (!pools.every(pool => Array.isArray(pool) && pool.length <= LIMITS.pool && pool.every(t => TILES.includes(t))) ||
    pools.reduce((n, pool) => n + pool.length, 0) > LIMITS.tiles) throw new Error('牌の内容または枚数が不正です。');
  if (g.wall.length < reserve) throw new Error('後続席の配牌に必要な山牌がありません。');
  for (const p of g.players) {
    if (typeof p.score !== 'number' || !Number.isFinite(p.score) || Math.abs(p.score) > 100000000) throw new Error('得点が不正です。');
  }
  if (![1, -1].includes(g.direction)) throw new Error('進行方向は1か-1です。');
  if (typeof g.turnSeconds !== 'number' || !Number.isFinite(g.turnSeconds)) throw new Error('持ち時間が不正です。');
  if (JSON.stringify(g.memory ?? {}).length > LIMITS.memory) throw new Error('記録できる情報が多すぎます。');
}

export const LANGUAGE = `codeはJavaScript(ES2023)。サーバー上のインタプリタで実行され、全員共通に適用される。
トップレベルではon(イベント名, (g, e) => { ... })でフックを登録するだけにする。トップレベルの変数に状態を保存しない(保持されない)。状態はg.memoryへ。複数登録可。関数・ループ・再帰・配列メソッド・Math・JSONなど標準機能は自由に使える。非同期処理・外部通信・タイマー・structuredCloneは不可。プロパティへの分割代入([a.x, b.x] = [b.x, a.x]や({k: o.x} = v))は構文エラーになるので一時変数を使う(変数への分割代入は可)。1回のフック実行は20万ステップ(ループ1周・関数1呼び出しが1ステップ)まで。例外や上限超過でそのコードは停止し、そのイベントでのそのコードの変更は取り消す。
イベント(before_は処理前、after_は処理後。短縮名draw等はafter_draw等と同じ):
round_start(開局。各席1回ずつactor=各席) / deal(配牌、各席1回) / draw(ツモ) / discard(打牌) / call(チー・ポン・大明槓) / turn(手番交代、actorは次の手番) / speech(審判が安全と判定した発言、e.text) / score(あがり点計算) / round_end(局の終了後のみ。あがり・流局とも、actorはあがった席か流局時の手番)。
開局順: before_round_start(手牌・河は空、山136枚)→各席before_deal→13枚配牌→after_deal→after_round_start→親のツモ。手番: 打牌→ロン・鳴き待ち→before_turn→turn更新→after_turn→ツモ。鳴き: before_call→副露確定→after_call→手番交代(大明槓のみツモ)。
暗槓・加槓・リーチ・ドラ・役・翻の組込みはない。コードで表現する(例: 役・翻・ドラはwin_scoreで加点、暗槓やリーチは宣言の発言をafter_speechで受けて手牌を副露へ移す・g.memoryに記録する)。
特別なイベント:
- win_check: あがれるか判定。e.allowedは通常判定(または前のコードの判定)、e.hand=判定する手牌(ロン牌込み)、e.tile=あがり牌、e.method="ツモ"/"ロン"、e.source=ロンなら放銃席。true/falseを返すと置き換え、undefinedなら変更なし。照会専用でgの変更は捨てられる。ボタン表示のため頻繁に呼ばれる。
- discard_check: e.tileを打牌してよいか。falseか理由の文字列を返すと禁止。全牌が禁止ならその手番は制限を無視。時間切れ・NPCは許可された牌を選ぶ。照会専用。
- call_check: e.callType(chi/pon/kan)、e.tiles(手牌から出す牌)、e.tile、e.source(放銃席)の鳴きを許可するか。falseを返すと禁止。照会専用。
- before_score / win_score / after_score: e.pointsは現在のあがり点(初期6000点)。数値を返すと置換。e.winner, e.loser(ツモは-1), e.method, e.hand(副露込みの全牌), e.tile。before_score→牌種ボーナス→win_score→after_scoreの順。100点単位に丸め0〜1000000点。
- payment: 支払い直前。e.deltasは席0〜3の点数増減の配列(ロンは放銃者が全額、ツモは3人が等分)。書き換えるか新しい配列を返して支払いを変える(責任払い・倍払いなど)。合計0でなくてもよい。
- round_end: 局の終了後。e.winner(流局は-1)、e.loser、e.method、e.deltas、e.drawn(流局ならtrue)。次局へ持ち越す情報はg.memoryへ保存する。gの得点変更は反映される。
引数e: type(イベント名), actor(対象の席0〜3), tile, text, callType, source, tiles, hand, points, winner, loser, method, deltas, allowed。該当しない値はundefinedか-1。
引数g(書き換えると処理後に一括反映。手牌・河・副露・山・得点・方向・持ち時間を直接書き換えてよい):
g.players[席]: {seat, name, score, hand:[牌], river:[打牌順の牌], melds:[{type, tiles:[牌], from:席}], isDealer}
g.wall: 山の配列。g.wall[0]が次のツモ牌、末尾が底。g.turn(手番), g.dealer(親), g.round(局数), g.direction(1=通常, -1=逆回り), g.turnSeconds(持ち時間秒、初期45、5〜300に丸める), g.claim(ロン・鳴き待ちの{tile, from}またはnull)。
g.memory: このコード専用の永続オブジェクト。局をまたいで保持し、好きなキーで状態を記録できる(JSON化して8000文字まで)。
g.draw(席, 枚数=1): 山から手牌へツモし、引いた牌の配列を返す(現在の手番ならツモあがり可能)。g.pay(払う席, 受け取る席, 点): 点の移動。g.award(席, 点): その席が他3人から各点を受け取る(負なら各員へ払う)。
g.win(席, 名前="生成ルールあがり"): 即あがり(通常の得点計算、手牌の形・枚数は問わない)。g.say(文字列): 卓へお知らせを表示(1回5件)。g.random(n): 0〜n-1の整数乱数。g.shuffle(配列): 配列をその場で並べ替えて返す。g.next(席): 進行方向の次の席。
共通ヘルパー: TILES(34種), rank(牌)=数字(字牌は1〜7), suit(牌)="m"/"p"/"s"/"z", isHonor(牌), isTerminal(牌), sortTiles(配列), countTile(配列, 牌), isWinningHand(牌配列, {melds:副露配列, joker:牌または牌配列, shape:"default"(通常形か七対子)/"standard"/"seven_pairs"})。
牌は"1m"〜"9m"(萬子),"1p"〜"9p"(筒子),"1s"〜"9s"(索子),"1z"東,"2z"南,"3z"西,"4z"北,"5z"白,"6z"發,"7z"中。同じ牌が5枚以上でも、牌の増減・移動・他人の手牌との交換もよい。1か所200枚、卓全体1024枚まで。
ツモ・ロンには手牌が14−副露数×3枚必要(win_checkがtrueでも)。g.winはこの制約なし。面子でない副露があると通常判定はあがり不可。手牌0枚の手番はスキップ。ロン・鳴き待ち中に牌を動かすと待ちを解除して次の手番へ進む。配牌中は後続席の13枚ずつを山に残す。
例: 親は追加で1枚ツモれるが各員へ300点払う:
on("after_draw", (g, e) => { if (e.actor === g.dealer && g.wall.length) { g.draw(e.actor); g.award(e.actor, -300); } });
例: 白(5z)をジョーカーにする:
on("win_check", (g, e) => e.allowed || isWinningHand(e.hand, {melds: g.players[e.actor].melds, joker: "5z"}));
例: 字牌は捨てられない:
on("discard_check", (g, e) => isHonor(e.tile) ? "字牌は捨てられません" : true);
例: 振り込んだ人は次局のあがり点が倍:
on("round_end", (g, e) => { g.memory.double = e.drawn ? -1 : e.loser; });
on("win_score", (g, e) => e.winner === g.memory.double ? e.points * 2 : e.points);`;
