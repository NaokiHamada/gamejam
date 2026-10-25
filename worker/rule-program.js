// A bounded, capability-free language. Generated text is data, never JavaScript.
export const LIMITS = Object.freeze({programs: 8, chars: 3000, totalChars: 12000, nodes: 160, depth: 12, steps: 4096});
const EVENTS = ['draw', 'discard', 'speech', 'win_check', 'win_score'];
const FIELDS = ['actor', 'turn', 'round', 'wall', 'text', 'tile', 'score', 'min_score', 'max_score', 'discard_count', 'hand_count'];
const COLLECTIONS = ['hand', 'river', 'discards'];
const VARIABLES = /^[a-z][a-z0-9_]{0,15}$/;
const ARITY = {'+': 2, '-': 2, '*': 2, '/': 2, '%': 2, '==': 2, '!=': 2, '>': 2, '>=': 2, '<': 2, '<=': 2,
  and: 2, or: 2, not: 1, if: 3, min: 2, max: 2, abs: 1, floor: 1, includes: 2, rank: 1, suit: 1};
const ACTIONS = {award: 1, win: 0, add_points: 1, reverse: 0, turn_time: 1, set: 2};
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
  check(Array.isArray(hooks) && hooks.length > 0 && hooks.length <= 4);
  let nodes = 0;
  const variables = new Set();
  const expression = (value, depth = 0, aggregate = false) => {
    check(++nodes <= LIMITS.nodes && depth <= LIMITS.depth, '生成コードが複雑すぎます。');
    if (typeof value === 'boolean') return;
    if (typeof value === 'number') { number(value); return; }
    if (typeof value === 'string') { check(value.length <= 80); return; }
    check(Array.isArray(value) && typeof value[0] === 'string');
    const [op, ...args] = value;
    if (op === 'get') { check(args.length === 1 && FIELDS.includes(args[0])); return; }
    if (op === 'var') {
      check(args.length === 1 && typeof args[0] === 'string' && VARIABLES.test(args[0])); variables.add(args[0]); return;
    }
    if (['count', 'sum', 'every', 'some'].includes(op)) {
      check(!aggregate && args.length === 2 && COLLECTIONS.includes(args[0]), 'コレクションの走査は入れ子にできません。');
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
      check(hook.on !== 'win_check' || op === 'win');
      check(hook.on !== 'win_score' || op === 'add_points');
      check(op !== 'add_points' || hook.on === 'win_score');
      check(op !== 'win' || ['speech', 'draw', 'win_check'].includes(hook.on));
      if (op === 'set') {
        check(typeof args[0] === 'string' && VARIABLES.test(args[0])); variables.add(args[0]);
        expression(args[1]);
      } else args.forEach(arg => expression(arg));
    }
  }
  check(variables.size <= 8, '生成コードの変数が多すぎます。');
  return hooks;
}

// Return a transaction of effects. No room state is reachable from this evaluator.
export function execute(hooks, event, context, previous = {}) {
  const memory = {...previous};
  const effects = {award: 0, bonus: 0, win: false, reverse: false, seconds: null, memory};
  let steps = LIMITS.steps;
  const evaluate = (value, tile = context.tile) => {
    check(--steps >= 0, '生成コードの実行量上限に達しました。');
    if (!Array.isArray(value)) return value;
    const [op, a, b, c] = value;
    if (op === 'get') return a === 'tile' ? tile : context[a];
    if (op === 'var') return Object.hasOwn(memory, a) ? memory[a] : 0;
    if (op === 'if') return evaluate(bool(evaluate(a, tile)) ? b : c, tile);
    if (op === 'and') return bool(evaluate(a, tile)) && bool(evaluate(b, tile));
    if (op === 'or') return bool(evaluate(a, tile)) || bool(evaluate(b, tile));
    if (['count', 'sum', 'every', 'some'].includes(op)) {
      const values = context[a];
      check(Array.isArray(values) && values.length <= 136);
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
    if (hook.on !== event || !bool(evaluate(hook.when))) continue;
    for (const [op, a, b] of hook.do) {
      check(--steps >= 0);
      switch (op) {
        case 'award': effects.award += number(evaluate(a)); check(Math.abs(effects.award) <= 3000); break;
        case 'add_points': effects.bonus += number(evaluate(a)); check(Math.abs(effects.bonus) <= 24000); break;
        case 'win': effects.win = true; break;
        case 'reverse': effects.reverse = !effects.reverse; break;
        case 'turn_time': effects.seconds = number(evaluate(a)); check(Number.isInteger(effects.seconds) && effects.seconds >= 15 && effects.seconds <= 120); break;
        case 'set': memory[a] = number(evaluate(b)); break;
      }
    }
  }
  // Scores remain integers in units of 100.
  effects.award = Math.trunc(effects.award / 100) * 100;
  effects.bonus = Math.trunc(effects.bonus / 100) * 100;
  return effects;
}

export const LANGUAGE = `ルールコードはJavaScriptではなくJSONの命令列。codeは次の配列をJSON文字列化する:
[{"on":"discard","when":["==",["get","tile"],"5z"],"do":[["award",500]]}]
on: draw(ツモ後),discard(打牌後),speech(安全と判定された発言),win_check(あがり条件追加),win_score(あがり点補正)。1コードに最大4フック、各doは最大8命令。
式: 数値/文字列/真偽値、["get",field]、["var",name](初期0)、[op,a,b]の+ - * / % == != > >= < <= and or min max includes、[op,a]のnot abs floor rank suit、["if",条件,真の場合,偽の場合]。
field: actor(席0〜3),turn,round,wall(残枚数),text(発言),tile(対象牌),score(本人点),min_score,max_score,discard_count(全打牌数),hand_count。
[op,collection,式]のcount,sum,every,someでhand(本人の手牌),river(本人の河),discards(全員の河)を走査。走査中のget tileは走査中の牌。走査の入れ子は禁止。
doの命令: ["award",式]本人が他3人から各点を獲得(負なら払う、1コード1イベント合計±3000以内)、["win"]あがり、["add_points",式]あがり点補正±24000、["reverse"]順番反転、["turn_time",式]15〜120秒、["set",name,式]本人専用のカウンタ更新(変数8個、英小文字開始の英数_16字以内、±100万)。カウンタは局をまたぎ保持。
win_checkはwinだけ、win_scoreはadd_pointsだけ。winはspeech/draw/win_checkのみ。win_checkは通常のあがりにOR追加で、手牌14枚が必要。draw/speechのwinは即あがり。add_pointsはwin_score専用。
同じイベント内の条件と手牌・点数は開始時のスナップショット。setした値は同コード内の後続命令から読める。
1コード3000文字/160ノード/深さ12/実行4096ステップ、同時8コード/合計12000文字。副作用は検証成功後に一括適用。外部アクセス・JS・ループ・再帰・動的プロパティ・任意関数呼び出し・他人の手牌参照は禁止。
例: 3回発言ごとに各員から300点:
[{"on":"speech","when":true,"do":[["set","n",["+",["var","n"],1]],["award",["if",["==",["%",["var","n"],3],0],300,0]]]}]
例: 字牌5枚以上であがり可能:
[{"on":"win_check","when":[">=",["count","hand",["==",["suit",["get","tile"]],"z"]],5],"do":[["win"]]}]`;
