import {TILES, winning} from './hand.js';
// A bounded, capability-free language. Generated text is data, never JavaScript.
export const LIMITS = Object.freeze({programs: 8, chars: 3000, totalChars: 12000, nodes: 160, depth: 12, steps: 4096, hooks: 16, tiles: 1024, pool: 136});
const ALIASES = {draw: 'after_draw', discard: 'after_discard', speech: 'after_speech'};
export const EVENTS = Object.freeze(['draw', 'discard', 'speech', 'win_check', 'win_score',
  ...['round_start', 'deal', 'draw', 'discard', 'call', 'turn', 'speech', 'score'].flatMap(name => [`before_${name}`, `after_${name}`])]);
const SCORE_EVENTS = ['before_score', 'win_score', 'after_score'];
const FIELDS = ['actor', 'dealer', 'turn', 'direction', 'turn_seconds', 'round', 'wall', 'text', 'tile', 'score', 'min_score', 'max_score', 'discard_count', 'hand_count', 'meld_count', 'call_type', 'source', 'points', 'loser', 'method'];
const COLLECTIONS = ['hand', 'river', 'discards', 'melds', 'scores', 'wall_tiles'];
const VARIABLES = /^[a-z][a-z0-9_]{0,15}$/;
const ARITY = {'+': 2, '-': 2, '*': 2, '/': 2, '%': 2, '==': 2, '!=': 2, '>': 2, '>=': 2, '<': 2, '<=': 2,
  and: 2, or: 2, not: 1, if: 3, min: 2, max: 2, abs: 1, floor: 1, includes: 2, rank: 1, suit: 1};
const TILE_EVENTS = ['draw', 'after_draw', 'speech', 'after_speech', 'after_deal', 'after_call', 'discard', 'after_discard'];
const TILE_ACTIONS = ['draw_tiles', 'return_tile', 'return_hand', 'move_tiles', 'copy_tiles', 'delete_tiles'];
const ACTIONS = {move_tiles: 4, copy_tiles: 4, delete_tiles: 3, draw_tiles: 1, return_tile: 1, return_hand: 0, award: 1, win: 0, allow_win: 1, add_points: 1, reverse: 0, turn_time: 1, set: 2};
function check(ok, message = '生成コードの形式が不正です。') { if (!ok) throw new Error(message); }
function number(value) {
  check(typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1000000, '生成コードの計算範囲を超えました。');
  return value;
}
function bool(value) { check(typeof value === 'boolean', '生成コードの条件は真偽値が必要です。'); return value; }
function string(value) { check(typeof value === 'string', '生成コードの文字列が不正です。'); return value; }

export function compile(code) {
  check(typeof code === 'string' && code.length <= LIMITS.chars, '生成コードが長すぎます。');
  const hooks = JSON.parse(code);
  check(Array.isArray(hooks) && hooks.length > 0 && hooks.length <= LIMITS.hooks);
  let nodes = 0;
  const variables = new Set();
  const collection = (value, depth, aggregate) => {
    if (typeof value === 'string') { check(COLLECTIONS.includes(value)); return; }
    check(Array.isArray(value) && ((value.length === 2 && ['hand', 'river', 'melds'].includes(value[0])) || (value.length === 3 && value[0] === 'meld')));
    value.slice(1).forEach(arg => expression(arg, depth + 1, aggregate));
  };
  const expression = (value, depth = 0, aggregate = false) => {
    check(++nodes <= LIMITS.nodes && depth <= LIMITS.depth, '生成コードが複雑すぎます。');
    if (typeof value === 'boolean') return;
    if (typeof value === 'number') { number(value); return; }
    if (typeof value === 'string') { check(value.length <= 80); return; }
    check(Array.isArray(value) && typeof value[0] === 'string');
    const [op, ...args] = value;
    if (op === 'size') {
      check(args.length === 1); collection(args[0], depth, aggregate); return;
    }
    if (op === 'copies' || op === 'at' || op === 'index_of') {
      check(args.length === 2);
      collection(args[0], depth, aggregate);
      expression(args[1], depth + 1, aggregate); return;
    }
    if (op === 'matches_hand') {
      check(args.length === 2 && ['default', 'standard', 'seven_pairs'].includes(args[0]));
      expression(args[1], depth + 1, aggregate); return;
    }
    if (op === 'get') { check(args.length === 1 && FIELDS.includes(args[0])); return; }
    if (op === 'var') {
      check(args.length === 1 && typeof args[0] === 'string' && VARIABLES.test(args[0])); variables.add(args[0]); return;
    }
    if (['count', 'sum', 'every', 'some'].includes(op)) {
      check(!aggregate && args.length === 2, 'コレクションの走査は入れ子にできません。');
      collection(args[0], depth, aggregate);
      expression(args[1], depth + 1, true); return;
    }
    check(Object.hasOwn(ARITY, op) && args.length === ARITY[op], '許可されていない命令です。');
    args.forEach(arg => expression(arg, depth + 1, aggregate));
  };
  for (const hook of hooks) {
    check(hook && Object.keys(hook).length === 3 && EVENTS.includes(hook.on) && Object.hasOwn(hook, 'when') &&
      Array.isArray(hook.do) && hook.do.length > 0 && hook.do.length <= 8);
    expression(hook.when);
    for (const action of hook.do) {
      check(Array.isArray(action) && typeof action[0] === 'string' && Object.hasOwn(ACTIONS, action[0]) && action.length === ACTIONS[action[0]] + 1);
      const [op, ...args] = action;
      // Queries have no side effects; scoring cannot trigger another event.
      check(hook.on !== 'win_check' || op === 'win' || op === 'allow_win');
      check(!SCORE_EVENTS.includes(hook.on) || op === 'add_points' || (hook.on !== 'win_score' && op === 'set'));
      check(op !== 'allow_win' || hook.on === 'win_check');
      check(op !== 'add_points' || SCORE_EVENTS.includes(hook.on));
      check(op !== 'win' || ['speech', 'draw', 'after_speech', 'after_draw', 'win_check'].includes(hook.on));
      check(!TILE_ACTIONS.includes(op) || TILE_EVENTS.includes(hook.on), '牌の移動は配牌・ツモ・鳴き・発言の処理後だけ利用できます。');
      if (['move_tiles', 'copy_tiles', 'delete_tiles'].includes(op)) {
        const pools = op === 'delete_tiles' ? 1 : 2;
        for (const pool of args.slice(0, pools)) {
          check(Array.isArray(pool) || ['hand', 'river', 'melds', 'wall_tiles'].includes(pool), '変更できない牌プールです。');
          collection(pool, 0, false);
        }
        args.slice(pools).forEach(arg => expression(arg));
      } else if (op === 'set') {
        check(typeof args[0] === 'string' && VARIABLES.test(args[0])); variables.add(args[0]);
        expression(args[1]);
      } else args.forEach(arg => expression(arg));
    }
  }
  check(variables.size <= 8, '生成コードの変数が多すぎます。');
  return hooks;
}

// Return a transaction of effects. No room state is reachable from this evaluator.
export function execute(hooks, event, context, previous = {}, tileState = null) {
  const memory = {...previous};
  const effects = {award: 0, bonus: 0, win: false, allowed: null, reverse: false, seconds: null, memory, tiles: null, drew: false};
  const moveTiles = () => {
    if (!effects.tiles) {
      effects.tiles = structuredClone(tileState || {
        hands: context.hands, rivers: context.rivers, melds: context.all_melds, wall: context.wall_tiles,
      });
    }
    return effects.tiles;
  };
  let steps = LIMITS.steps;
  const groupIndex = (expr, groups) => {
    const index = number(evaluate(expr));
    check(Number.isInteger(index) && index >= 0 && index < groups.length, '副露の位置が範囲外です。');
    return index;
  };
  const collection = (selector, tile) => {
    let values;
    if (Array.isArray(selector)) {
      // Seat/index expressions use the same item as the enclosing scan.
      const seat = seatIndexValue(evaluate(selector[1], tile));
      if (selector[0] === 'hand') values = context.hands?.[seat];
      if (selector[0] === 'river') values = context.rivers?.[seat];
      if (selector[0] === 'melds') values = context.all_melds?.[seat]?.flatMap(m => m.tiles);
      if (selector[0] === 'meld') {
        const groups = context.all_melds?.[seat];
        const index = evaluate(selector[2], tile);
        check(Array.isArray(groups) && Number.isInteger(index) && index >= 0 && index < groups.length);
        values = groups[index].tiles;
      }
    } else values = context[selector];
    check(Array.isArray(values) && values.length <= LIMITS.tiles);
    return values;
  };
  const seatIndexValue = value => {
    const seat = number(value);
    check(Number.isInteger(seat) && seat >= 0 && seat < 4, '席は0〜3の整数が必要です。');
    return seat;
  };
  const pool = selector => {
    const state = moveTiles();
    const kind = Array.isArray(selector) ? selector[0] : selector;
    const seat = Array.isArray(selector) ? seatIndexValue(evaluate(selector[1])) : context.actor;
    let values;
    if (kind === 'wall_tiles') values = state.wall;
    if (kind === 'hand') values = state.hands[seat];
    if (kind === 'river') values = state.rivers[seat];
    if (kind === 'meld') values = state.melds[seat][groupIndex(selector[2], state.melds[seat])].tiles;
    if (kind === 'melds') {
      const groups = state.melds[seat];
      return {
        values: groups.flatMap(m => m.tiles), kind, seat,
        remove(index, count) {
          let offset = 0;
          for (const group of groups) {
            const length = group.tiles.length;
            const from = Math.max(0, index - offset), to = Math.min(length, index + count - offset);
            if (to > from) group.tiles.splice(from, to - from);
            offset += length;
          }
        },
        append(tiles) { if (tiles.length) groups.push({type: 'exposed', tiles: [...tiles], from: context.actor}); },
      };
    }
    check(Array.isArray(values), '変更できない牌プールです。');
    return {values, kind, seat, remove: (index, count) => values.splice(index, count), append: tiles => values.push(...tiles)};
  };
  const validateTiles = () => {
    const state = effects.tiles;
    if (!state) return;
    const pools = [state.wall, ...state.hands, ...state.rivers, ...state.melds.map(groups => groups.flatMap(m => m.tiles))];
    check(pools.every(values => values.length <= LIMITS.pool && values.every(t => TILES.includes(t))) &&
      pools.reduce((n, values) => n + values.length, 0) <= LIMITS.tiles, '牌プールの上限を超えました。');
    check(state.wall.length >= (context.wall_reserve || 0), '後続席の配牌に必要な山牌がありません。');
  };
  const evaluate = (value, tile = context.tile) => {
    check(--steps >= 0, '生成コードの実行量上限に達しました。');
    if (!Array.isArray(value)) return value;
    const [op, a, b, c] = value;
    if (op === 'size') return collection(a, tile).length;
    if (op === 'index_of') return collection(a, tile).indexOf(evaluate(b, tile));
    if (op === 'copies') {
      const values = collection(a, tile), target = evaluate(b, tile);
      check(typeof target === 'string' || typeof target === 'number');
      return values.filter(value => value === target).length;
    }
    if (op === 'at') {
      const values = collection(a, tile), index = number(evaluate(b, tile));
      check(Number.isInteger(index) && index >= 0 && index < values.length, '参照位置が範囲外です。');
      return values[index];
    }
    if (op === 'matches_hand') {
      const joker = string(evaluate(b, tile));
      check(joker === 'none' || TILES.includes(joker));
      return winning(context.hand, a, joker, context.hand_melds || []);
    }
    if (op === 'get') return a === 'tile' ? tile : context[a];
    if (op === 'var') return Object.hasOwn(memory, a) ? memory[a] : 0;
    if (op === 'if') return evaluate(bool(evaluate(a, tile)) ? b : c, tile);
    if (op === 'and') return bool(evaluate(a, tile)) && bool(evaluate(b, tile));
    if (op === 'or') return bool(evaluate(a, tile)) || bool(evaluate(b, tile));
    if (['count', 'sum', 'every', 'some'].includes(op)) {
      const values = collection(a, tile);
      const results = values.map(item => evaluate(b, item));
      if (op === 'count') return results.filter(bool).length;
      if (op === 'sum') return number(results.reduce((sum, n) => sum + number(n), 0));
      if (op === 'every') return results.every(bool);
      return results.some(bool);
    }
    const x = evaluate(a, tile);
    if (op === 'not') return !bool(x);
    if (op === 'abs') return Math.abs(number(x));
    if (op === 'floor') return Math.floor(number(x));
    if (op === 'rank') return Number(string(x)[0]) || 0;
    if (op === 'suit') return string(x)[1] || '';
    const y = evaluate(b, tile);
    if (op === '==') return x === y;
    if (op === '!=') return x !== y;
    if (op === 'includes') return string(x).includes(string(y));
    number(x); number(y);
    switch (op) {
      case '+': return number(x + y);
      case '-': return number(x - y);
      case '*': return number(x * y);
      case '/': check(y !== 0); return number(x / y);
      case '%': check(y !== 0); return number(x % y);
      case 'min': return Math.min(x, y);
      case 'max': return Math.max(x, y);
      case '>': return x > y;
      case '>=': return x >= y;
      case '<': return x < y;
      case '<=': return x <= y;
      default: throw new Error('許可されていない命令です。');
    }
  };
  for (const hook of hooks) {
    if ((ALIASES[hook.on] || hook.on) !== (ALIASES[event] || event) || !bool(evaluate(hook.when))) continue;
    for (const [op, a, b, c, d] of hook.do) {
      check(--steps >= 0);
      switch (op) {
        case 'move_tiles':
        case 'copy_tiles':
        case 'delete_tiles': {
          const source = pool(a), target = op === 'delete_tiles' ? null : pool(b);
          const index = number(evaluate(op === 'delete_tiles' ? b : c));
          const count = number(evaluate(op === 'delete_tiles' ? c : d));
          check(Number.isInteger(index) && index >= 0 && Number.isInteger(count) && count >= 1 &&
            count <= LIMITS.pool && index + count <= source.values.length, '牌の範囲が不正です。');
          const selected = source.values.slice(index, index + count);
          if (op !== 'copy_tiles') source.remove(index, count);
          if (target) {
            target.append(selected);
            if (target.kind === 'hand' && target.seat === (event === 'after_call' ? context.actor : context.turn)) effects.drew = true;
          }
          validateTiles();
          break;
        }
        case 'draw_tiles': {
          const count = number(evaluate(a));
          check(Number.isInteger(count) && count >= 1 && count <= LIMITS.pool, 'ツモ枚数は1〜136の整数が必要です。');
          const state = moveTiles();
          check(count <= state.wall.length - (context.wall_reserve || 0), 'ツモに必要な山牌がありません。');
          state.hands[context.actor].push(...state.wall.splice(0, count));
          effects.drew ||= context.actor === context.turn || event === 'after_call';
          validateTiles();
          break;
        }
        case 'return_tile': {
          const tile = string(evaluate(a)), state = moveTiles(), hand = state.hands[context.actor], index = hand.indexOf(tile);
          check(index >= 0, '山へ戻す牌が手牌にありません。');
          hand.splice(index, 1); state.wall.push(tile);
          validateTiles();
          break;
        }
        case 'return_hand': {
          const state = moveTiles(), hand = state.hands[context.actor];
          state.wall.push(...hand.splice(0).reverse());
          validateTiles();
          break;
        }
        case 'award': effects.award += number(evaluate(a)); check(Math.abs(effects.award) <= 3000); break;
        case 'add_points': effects.bonus += number(evaluate(a)); check(Math.abs(effects.bonus) <= 24000); break;
        case 'allow_win': effects.allowed = bool(evaluate(a)); effects.win = false; break;
        case 'win': effects.win = true; break;
        case 'reverse': effects.reverse = !effects.reverse; break;
        case 'turn_time': effects.seconds = number(evaluate(a)); check(Number.isInteger(effects.seconds) && effects.seconds >= 15 && effects.seconds <= 120); break;
        case 'set': memory[a] = number(evaluate(b)); break;
      }
    }
  }
  if (effects.tiles) {
    validateTiles();
    effects.tiles.melds = effects.tiles.melds.map(groups => groups.filter(m => m.tiles.length));
  }
  // Scores remain integers in units of 100.
  effects.award = Math.trunc(effects.award / 100) * 100;
  effects.bonus = Math.trunc(effects.bonus / 100) * 100;
  return effects;
}

export const LANGUAGE = `ルールコードはJavaScriptではなくJSONの命令列。codeは次の配列をJSON文字列化する:
[{"on":"discard","when":["==",["get","tile"],"5z"],"do":[["award",500]]}]
on: before_/after_とround_start(開局、各席1回),deal(配牌、各席1回),draw(ツモ),discard(打牌),call(鳴き),turn(手番交代、actorは次の手番),speech(安全判定された発言),score(あがり点計算)を結合したイベント名。beforeは処理前、afterは処理後。
開局順: before_round_start(手牌・河を空にし山136枚を準備済み)→各席のbefore_deal→13枚配牌→after_deal→after_round_start→親のdraw。手番交代: before_turn→turn更新→after_turn→draw。鳴き: before_call→副露確定→after_call→turn前後→カンのみdraw。call_typeはchi/pon/kan(大明槓)、sourceは放銃席。チーは進行方向の次席だけ。ロン優先、ポン/カン優先、同順位は進行方向の近い席。暗槓・加槓は未対応。
draw/discard/speechはそれぞれafter_draw/after_discard/after_speechの互換名。win_checkはあがり条件の追加・置換、win_scoreは既存のあがり点補正。1コード最大16フック、各do最大8命令。
式: ["matches_hand","default"/"standard"/"seven_pairs",ジョーカー牌コードまたは"none"]は手牌の形を判定(defaultは通常形または七対子、standardは4面子＋雀頭、seven_pairsは七対子のみ。副露も考慮)。数値/文字列/真偽値、["get",field]、["var",name](初期0)、[op,a,b]の+ - * / % == != > >= < <= and or min max includes、[op,a]のnot abs floor rank suit、["if",条件,真の場合,偽の場合]。
field: direction(通常1/逆-1),turn_seconds(現在の秒数),actor(席0〜3),dealer(現在の親の席0〜3、手番や進行方向とは独立),turn,round,wall(残枚数),text(発言),tile(対象牌),score(本人点),min_score,max_score,discard_count(河に残る全打牌数),hand_count,meld_count(副露数),call_type(鳴き種別、他は空文字),source(放銃席、他は-1),points(計算中の基本点、得点計算以外0),loser(ロン放銃席、ツモは-1),method(ツモ/ロン等のあがり名)。
[op,collection,式]のcount,sum,every,someでhand(本人の手牌),river(本人の河),discards(全員の河),melds(本人の副露牌)、scores(席0〜3順の全員の得点),wall_tiles(未ツモの山、先頭が次のツモ牌)を走査。collectionには["river",席の式]も指定でき、指定席の河を古い打牌順に参照できる。走査中のget tileは走査中の牌、scoresでは得点の数値。["at",collection,位置の式]は0始まりの指定位置の値を返す。席は0〜3の整数、位置は範囲内の整数が必要で、不正ならコードを停止する。空の山の先頭はget wallが0より大きい条件内だけで参照する。例: ["at","scores",["get","dealer"]]は親の得点、["at","wall_tiles",0]は次のツモ牌。["copies",collection,牌の式]で指定牌の枚数を取得(走査内でも利用可)。例: ["some","hand",[">=",["copies","hand",["get","tile"]],2]]は対子1組以上。走査の入れ子は禁止。
牌プール: "hand"(本人の手牌),"river"(本人の河),"melds"(本人の全副露牌),"wall_tiles"(次にツモる順の山)。["hand",席の式],["river",席の式],["melds",席の式]で他人も指定できる。["meld",席の式,副露位置の式]で個々の副露を指定(0始まり)。すべてsize/at/index_of/copies/count/sum/every/someで読み取れる。他人の手牌もルール内では参照可能。ブラウザや生成AIへは送信しない。["size",collection]は要素数、["index_of",collection,牌の式]は最初の位置(なければ-1)。
汎用牌操作: ["move_tiles",移動元プール,移動先プール,開始位置の式,枚数の式]、["copy_tiles",コピー元プール,コピー先プール,開始位置の式,枚数の式]、["delete_tiles",削除元プール,開始位置の式,枚数の式]。0始まりの連続範囲、枚数1〜136。移動・コピー先の末尾に追加(山は底)、元と先が同一でも可。手牌→他人の手牌、河→手牌、河→山、晒した牌→手牌などすべて同じ命令。移動は総数維持、コピーは増加、削除は減少。同じ牌が4枚を超えても可。1プール136枚、卓全体1024枚まで。scores/discardsは読み取り専用(全員の河を変えるには各席のriverを指定)。
副露全体への追加は新しい公開グループとなる。個々の副露への追加はそのグループの末尾へ追加。空グループはコード成功時に除去。面子が崩れた副露がある間は通常形のあがり不可、面子の形を直せば再判定可能。副露は全員へ公開される。
簡易命令: ["draw_tiles",枚数の式]は本人へ山の先頭から追加ツモ、["return_tile",牌の式]は本人の手牌の一致する1枚を山の底へ戻す、["return_hand"]は本人の手元の全牌を山の底へ戻す。例: [["return_hand"],["draw_tiles",["get","hand_count"]]]で全手牌交換。
牌操作はafter_deal/after_draw/after_call/after_discard/after_speechと互換名draw/discard/speechだけ。追加ツモはdrawフックを再発火させない。ロン・鳴き待ち中の牌操作では待ちを解除して次の手番へ進む。手牌0枚も可、打牌できない手番はサーバーの次のtickでスキップ。通常の打牌1枚、ツモ・ロンは14−副露数×3枚の条件を維持。配牌後は後続席の13枚ずつを山に確保。未配牌席への移動・コピーは通常13枚の配牌と別に保持。
操作は記述順・コード登録順に共有する作業用の全員の手牌/河/副露/山へ適用。式はイベント開始時のスナップショットを読む。範囲外・上限超過・不正な牌ならそのコードの牌操作・加点・カウンタをすべて取り消して停止。
doの命令: ["award",式]本人が他3人から各点を獲得(負なら払う、1コード1イベント合計±3000以内)、["win"]あがり、["add_points",式]あがり点補正±24000、["reverse"]順番反転、["turn_time",式]15〜120秒、["set",name,式]本人専用のカウンタ更新(変数8個、英小文字開始の英数_16字以内、±100万)。カウンタは局をまたぎ保持。
win_checkはwinと["allow_win",真偽式]だけ。allow_winは初期判定を置き換え、複数コードは登録順に適用。win_scoreはadd_pointsだけ。before_score/after_scoreはadd_pointsとsetだけ。winはafter_speech/after_drawとその互換名およびwin_checkのみ。win_checkのwinは条件を追加、allow_winは条件を置換し、手牌が14-副露数×3枚必要。after_draw/after_speechのwinは即あがり。add_pointsはbefore_score/win_score/after_score専用。
点数計算: before_score(pointsは初期6000点)→牌種ボーナスとwin_score補正→1000〜60000に制限→after_score(pointsはこの計算結果)→再び1000〜60000に制限→支払い。各段階のadd_pointsはその段階の値へ加算。得点計算のhandは副露を含む全牌、他のイベントでは手元の牌。
同じイベント内の条件と手牌・点数は開始時のスナップショット。setした値は同コード内の後続命令から読める。
1コード3000文字/160ノード/深さ12/実行4096ステップ、同時8コード/合計12000文字。副作用は検証成功後に一括適用。外部アクセス・JS・ループ・再帰・動的プロパティ・任意関数呼び出しは禁止。
例: 3回発言ごとに各員から300点:
[{"on":"speech","when":true,"do":[["set","n",["+",["var","n"],1]],["award",["if",["==",["%",["var","n"],3],0],300,0]]]}]
例: 字牌5枚以上であがり可能:
[{"on":"win_check","when":[">=",["count","hand",["==",["suit",["get","tile"]],"z"]],5],"do":[["win"]]}]`;
