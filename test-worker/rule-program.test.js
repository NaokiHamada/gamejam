import {describe, it, expect} from 'vitest';
import {compile, execute, LIMITS} from '../worker/rule-program.js';
import {Room, DEFAULT_RULES} from '../worker/game.js';
import {validateVerdict, updatePrograms, penalty} from '../worker/referee.js';

const code = (on, when, actions) => JSON.stringify([{on, when, do: actions}]);
const verdict = program => ({accepted: true, justification: 'sufficient', violation: 'none', severity: 0, title: '自由ルール', explanation: '発動条件と効果',
  rules: {...DEFAULT_RULES}, program: {mode: 'add', id: 'custom', code: program}});
function roomWith(program) {
  const room = new Room('ABCDE');
  for (let i = 0; i < 4; i++) room.join(`人${i}`).ready = true;
  room.start(room.players[0]);
  room.programs = updatePrograms([], validateVerdict(verdict(program)));
  return room;
}
describe('生成ルールの実行と制限', () => {
  it('発言カウンタを各人に独立して保持し、3回目だけ加点する', () => {
    const program = code('speech', true, [['set', 'n', ['+', ['var', 'n'], 1]],
      ['award', ['if', ['==', ['%', ['var', 'n'], 3], 0], 300, 0]]]);
    const room = roomWith(program);
    room.speech(room.players[0], '一'); room.speech(room.players[1], '別の人'); room.speech(room.players[0], '二');
    expect(room.players.map(p => p.score)).toEqual([25000, 25000, 25000, 25000]);
    room.speech(room.players[0], '三');
    expect(room.players.map(p => p.score)).toEqual([25900, 24700, 24700, 24700]);
    const restored = Room.restore(JSON.parse(JSON.stringify(room)));
    expect(restored.programs[0].memory[0].n).toBe(3);
    expect(restored.snapshot(restored.players[1]).programs[0]).not.toHaveProperty('memory');
    expect(restored.snapshot(restored.players[1]).programs[0].code).toBe(program);
  });
  it('独自の複合条件でツモ・ロンを許可し、照会で副作用を起こさない', () => {
    const program = code('win_check', ['and', ['>=', ['count', 'hand', ['==', ['suit', ['get', 'tile']], 'z']], 5],
      ['==', ['%', ['get', 'round'], 2], 1]], [['win']]);
    const room = roomWith(program), p = room.players[0];
    p.hand = '1z 2z 3z 4z 5z 1m 3m 5m 7m 9m 2p 4p 6p 8p'.split(' ');
    expect(room.snapshot(p).can_tsumo).toBe(true);
    const before = JSON.stringify(room);
    expect(room.snapshot(p).can_tsumo).toBe(true);
    expect(JSON.stringify(room)).toBe(before);
    p.hand.pop();
    room.claim = {from: 1, tile: '8p', passed: [], deadline: Date.now() / 1000 + 8};
    expect(room.canRon(0)).toBe(true);
    room.round = 2;
    expect(room.canRon(0)).toBe(false);
    expect(room.isWinning(0, p.hand)).toBe(false);
  });
  it('牌と点差の計算で得点を変え、得点総計を維持する', () => {
    const room = roomWith(code('win_score', true, [['add_points', ['*', ['sum', 'hand', ['rank', ['get', 'tile']]], 100]]]));
    room.finish(0, 1, ['5z'], 'テスト');
    expect(room.result.deltas).toEqual([6500, -6500, 0, 0]);
    expect(room.players.reduce((n, p) => n + p.score, 0)).toBe(100000);
  });
  it('打牌イベントで条件付き加点と逆回りを処理する', () => {
    const room = roomWith(code('discard', ['==', ['get', 'tile'], '5z'], [['award', 500], ['reverse']]));
    room.players[0].hand[0] = '5z';
    room.discard(room.players[0], '5z');
    expect(room.players[0].score).toBe(26500);
    expect(room.direction).toBe(-1);
  });
  it('ツモ後の生成ルール即あがりで対局を完了する', () => {
    const room = roomWith(code('draw', true, [['win']]));
    room.advance();
    expect(room.status).toBe('finished');
    expect(room.result.winner).toBe(1);
    expect(room.result.deltas.reduce((a, b) => a + b, 0)).toBe(0);
  });
  it('あがり条件の計算失敗は照会では状態を変えず、操作時に無効化する', () => {
    const room = roomWith(code('win_check', ['>', ['/', 1, 0], 0], [['win']]));
    room.players[0].hand = '1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 2p 3p 4p 5p'.split(' ');
    const before = JSON.stringify(room);
    expect(room.snapshot(room.players[0]).can_tsumo).toBe(false);
    expect(JSON.stringify(room)).toBe(before);
    expect(room.isWinning(0, room.players[0].hand)).toBe(false);
    expect(room.programs[0].disabled).toBe(true);
    expect(room.messages.at(-1).kind).toBe('error');
  });
  it('持ち時間に整数以外を適用しない', () => {
    const room = roomWith(code('speech', true, [['turn_time', ['/', 31, 2]]]));
    room.speech(room.players[0], 'テスト');
    expect(room.turn_seconds).toBe(45);
    expect(room.programs[0].disabled).toBe(true);
  });
  it.each(['fetch', 'eval', 'constructor', '__proto__', 'while', 'import', 'getPrototypeOf'])(
    '任意命令%sと秘密フィールドを拒否する', op => {
      expect(() => compile(code('speech', [op, 'secret'], [['award', 300]]))).toThrow();
      expect(() => compile(code('speech', ['get', 'OPENAI_API_KEY'], [['win']]))).toThrow();
    });
  it('深さ・ノード数・走査の入れ子・コード長・副作用のある照会を拒否する', () => {
    let expr = true;
    for (let i = 0; i < 14; i++) expr = ['not', expr];
    expect(() => compile(code('speech', expr, [['win']]))).toThrow();
    const wide = depth => depth ? ['and', wide(depth - 1), wide(depth - 1)] : true;
    expect(() => compile(code('speech', wide(7), [['win']]))).toThrow();
    expect(() => compile(code('speech', ['some', 'hand', ['some', 'hand', true]], [['win']]))).toThrow();
    expect(() => compile(' '.repeat(LIMITS.chars + 1))).toThrow();
    expect(() => compile(code('win_check', true, [['award', 100]]))).toThrow();
    expect(() => compile(code('win_score', true, [['win']]))).toThrow();
  });
  it('実行量上限を強制する', () => {
    let expr = ['==', ['get', 'tile'], '1m'];
    for (let i = 0; i < 10; i++) expr = ['if', expr, true, false];
    const hooks = compile(code('speech', true, Array.from({length: 4}, () => ['award', ['count', 'discards', expr]])));
    expect(() => execute(hooks, 'speech', {discards: Array(136).fill('1m')}, {})).toThrow();
  });
  it.each([['/', 0], ['*', 1000000]])('計算失敗%sで先行命令を含めた副作用を取り消し、減点せず無効化する', (op, n) => {
    const room = roomWith(code('speech', true, [['set', 'n', 1], ['award', 300], ['award', [op, 1000, n]]]));
    room.speech(room.players[0], 'テスト');
    expect(room.players.map(p => p.score)).toEqual([25000, 25000, 25000, 25000]);
    expect(room.programs[0].memory[0]).toEqual({});
    expect(room.programs[0].disabled).toBe(true);
    expect(room.messages.at(-1).kind).toBe('error');
    expect(room.status).toBe('playing');
  });
  it('生成ルールを置換・撤回・初期化でき、件数上限を超えた追加は原状を維持する', () => {
    const room = roomWith(code('speech', true, [['award', 100]])), original = room.programs;
    const change = verdict(code('speech', true, [['award', 200]])); change.program.mode = 'replace';
    room.programs = updatePrograms(room.programs, change);
    expect(room.programs[0].code).toBe(change.program.code);
    for (let i = 1; i < 8; i++) { change.program = {...change.program, mode: 'add', id: 'rule' + i}; room.programs = updatePrograms(room.programs, change); }
    change.program.id = 'overflow';
    expect(() => updatePrograms(room.programs, change)).toThrow();
    expect(room.programs).toHaveLength(8);
    expect(updatePrograms(original, {...change, program: {mode: 'remove', id: 'custom', code: ''}})).toEqual([]);
    room.status = 'finished'; room.action('reset_rules', room.players[0], {});
    expect(room.programs).toEqual([]);
  });
  it.each(['malicious', 'load', 'tokens', 'boring'])('チョンボ%sのカテゴリと程度に応じて減点・分配する', violation => {
    const room = roomWith(code('speech', true, [['award', 100]]));
    const points = penalty(violation, 2);
    expect(points).toBeGreaterThan(penalty(violation, 1));
    room.chonbo(2, violation, points, '禁止内容の説明');
    expect(room.players[2].score).toBe(25000 - points);
    expect(room.players[0].score).toBe(25000 + points / 3);
    expect(room.players.reduce((n, p) => n + p.score, 0)).toBe(100000);
    expect(room.messages.at(-1).kind).toBe('chonbo');
  });
});

describe('旧固定項目を生成コードで扱う', () => {
  const pair = '1m 1m 3m 5m 7m 9m 2p 4p 6p 8p 1s 3s 5s 7s'.split(' ');
  const pairs = '1m 1m 3m 3m 5p 5p 7p 7p 4s 4s 2z 2z 3z 3z'.split(' ');
  it('七対子の禁止・再許可・ジョーカーの判定を照会とツモ・ロンに反映する', () => {
    const room = roomWith(code('win_check', true, [['allow_win', ['matches_hand', 'standard', 'none']]]));
    const p = room.players[0]; p.hand = [...pairs];
    const before = JSON.stringify(room);
    expect(room.snapshot(p).can_tsumo).toBe(false);
    expect(JSON.stringify(room)).toBe(before);
    expect(() => room.win(p, 'tsumo')).toThrow();
    room.programs = updatePrograms(room.programs, {...verdict(code('win_check', true,
      [['allow_win', ['matches_hand', 'seven_pairs', 'none']]])), program: {mode: 'remove', id: 'custom', code: ''}});
    expect(room.snapshot(p).can_tsumo).toBe(true);
    const jokerCode = code('win_check', true, [['allow_win', ['matches_hand', 'default', '5z']]]);
    room.programs = updatePrograms([], verdict(jokerCode));
    p.hand = '5z 2m 3m 4m 5m 6m 2p 3p 4p 7s 8s 9s 1z 1z'.split(' ');
    expect(room.snapshot(p).can_tsumo).toBe(true);
    p.hand.pop(); room.claim = {from: 1, tile: '1z', passed: [], deadline: Date.now() / 1000 + 8};
    expect(room.canRon(0)).toBe(true);
    room.win(p, 'ron'); expect(room.result.winner).toBe(0);
  });
  it('条件置換で通常形を拒否し、登録順に判定を合成する', () => {
    const room = roomWith(code('win_check', true, [['allow_win', false]]));
    const standard = '1m 2m 3m 4m 5m 6m 2p 3p 4p 7s 8s 9s 1z 1z'.split(' ');
    expect(room.isWinning(0, standard)).toBe(false);
    room.programs.push({...room.programs[0], id: 'add', code: code('win_check', true, [['win']])});
    expect(room.isWinning(0, standard)).toBe(true);
    room.programs.push({...room.programs[0], id: 'last'});
    expect(room.isWinning(0, standard)).toBe(false);
    expect(room.isWinning(0, standard.slice(1))).toBe(false);
    room.programs = updatePrograms([], verdict(code('win_check', true, [['win'], ['allow_win', false]])));
    expect(room.isWinning(0, standard)).toBe(false);
  });
  it('任意条件・12000点・逆回り・20秒をコードで適用し、復元・初期化する', () => {
    const room = roomWith(JSON.stringify([
      {on: 'win_check', when: true, do: [['allow_win', ['some', 'hand', ['>=', ['copies', 'hand', ['get', 'tile']], 2]]]]},
      {on: 'before_score', when: true, do: [['add_points', 6000]]},
      {on: 'before_discard', when: ['==', ['get', 'direction'], 1], do: [['reverse']]},
      {on: 'before_draw', when: true, do: [['turn_time', 20]]},
    ]));
    room.players[0].hand = [...pair];
    expect(room.isWinning(0, pair)).toBe(true);
    expect(room.isWinning(0, pair.map((t, i) => i === 0 ? '9s' : t))).toBe(false);
    room.discard(room.players[0], '7s');
    expect(room.direction).toBe(-1);
    if (room.claim) { room.claim = null; room.advance(); }
    expect(room.turn).toBe(3); expect(room.turn_seconds).toBe(20);
    const restored = Room.restore(JSON.parse(JSON.stringify(room)));
    expect(restored.direction).toBe(-1); expect(restored.turn_seconds).toBe(20);
    restored.finish(0, 1, pair, 'ロン');
    expect(restored.result.deltas).toEqual([12000, -12000, 0, 0]);
    restored.action('reset_rules', restored.players[0], {});
    expect(restored.direction).toBe(1); expect(restored.turn_seconds).toBe(45);
    expect(restored.programs).toEqual([]);
    expect(restored.rules).toEqual(DEFAULT_RULES);
  });
  it('旧設定を復元しても固定項目を公開・適用しない', () => {
    const room = roomWith(code('win_check', true, [['allow_win', false]]));
    room.rules = {...room.rules, win_condition: 'any_pair', seven_pairs: false, joker: '5z',
      win_points: 24000, reverse_order: true, turn_seconds: 15};
    const restored = Room.restore(JSON.parse(JSON.stringify(room)));
    expect(restored.snapshot(restored.players[0]).rules).toEqual(DEFAULT_RULES);
    expect(restored.isWinning(0, pair)).toBe(false);
    restored.finish(0, 1, pair, 'ロン'); expect(restored.result.deltas[0]).toBe(6000);
  });
  it('照会以外の判定置換と不正な形・代用牌・真偽値を拒否する', () => {
    expect(() => compile(code('draw', true, [['allow_win', true]]))).toThrow();
    expect(() => compile(code('win_check', true, [['allow_win', ['matches_hand', 'unknown', 'none']]]))).toThrow();
    for (const expr of [1, ['matches_hand', 'standard', 'secret']]) {
      const room = roomWith(code('win_check', true, [['allow_win', expr]]));
      expect(room.isWinning(0, pair)).toBe(false);
      expect(room.programs[0].disabled).toBe(true);
    }
  });
});

describe('卓の状態参照と牌の移動', () => {
  const tiles = room => [...room.wall, ...room.players.flatMap(p => [...p.hand, ...p.river, ...p.melds.flatMap(m => m.tiles)])].sort();
  it('親は局ごとに移り、手番・逆回りとは独立している', () => {
    const room = roomWith(code('speech', true, [['set', 'dealer', ['get', 'dealer']]]));
    room.turn = 3; room.direction = -1;
    room.speech(room.players[2], '親');
    expect(room.programs[0].memory[2].dealer).toBe(0);
    room.status = 'finished'; room.start(room.players[0]);
    expect(room.programContext(2).dealer).toBe(1);
    expect(Room.restore(JSON.parse(JSON.stringify(room))).programContext(0).dealer).toBe(1);
  });
  it('席別得点・河・全員の得点・山の牌と順序を式から参照する', () => {
    const room = roomWith(code('speech', true, [
      ['set', 'parent', ['at', 'scores', ['get', 'dealer']]],
      ['set', 'total', ['sum', 'scores', ['get', 'tile']]],
      ['set', 'low', ['count', 'scores', ['<', ['get', 'tile'], 25000]]],
      ['set', 'river', ['copies', ['river', ['get', 'source']], '5z']],
      ['set', 'wall', ['copies', 'wall_tiles', '5z']],
      ['set', 'next', ['rank', ['at', 'wall_tiles', 0]]],
      ['set', 'last', ['rank', ['at', ['river', 3], 1]]],
    ]));
    room.players.forEach((p, i) => { p.score = [28000, 24000, 25000, 23000][i]; });
    room.players[3].river = ['5z', '3p']; room.wall = ['5z', '5z', '2s'];
    room.applyPrograms('speech', 2, {source: 3});
    expect(room.programs[0].memory[2]).toEqual({parent: 28000, total: 100000, low: 2, river: 1, wall: 2, next: 2, last: 3});
    const context = room.programContext(2);
    context.scores[0] = 0; context.rivers[3].pop(); context.wall_tiles.pop();
    expect(room.players[0].score).toBe(28000);
    expect(room.players[3].river).toEqual(['5z', '3p']);
    expect(room.wall).toEqual(['5z', '5z', '2s']);
    expect(room.snapshot(room.players[2])).not.toHaveProperty('wall_tiles');
  });
  it.each([-1, 4, 0.5, '0'])('不正な席%sを拒否し先行加点も取り消す', seat => {
    const room = roomWith(code('speech', true, [['award', 300], ['set', 'n', ['copies', ['river', seat], '5z']]]));
    room.speech(room.players[0], 'テスト');
    expect(room.programs[0].disabled).toBe(true);
    expect(room.players[0].score).toBe(25000);
  });
  it.each([-1, 4, 0.5])('範囲外の位置%sを拒否する', index => {
    expect(() => execute(compile(code('speech', true, [['set', 'n', ['at', 'scores', index]]])), 'speech', {scores: [1, 2, 3, 4]})).toThrow();
  });
  it('空の山は条件分岐で安全に扱え、秘密や不正なセレクタは参照できない', () => {
    const program = code('speech', ['>', ['get', 'wall'], 0], [['set', 'n', ['rank', ['at', 'wall_tiles', 0]]]]);
    expect(execute(compile(program), 'speech', {wall: 0, wall_tiles: []}).memory).toEqual({});
    for (const selector of ['players', 'tokens', ['tokens', 1], ['river', 1, 2]]) {
      expect(() => compile(code('speech', true, [['set', 'n', ['at', selector, 0]]]))).toThrow();
    }
  });
  it('通常のツモ後に追加2枚をツモり、再帰せず牌136枚を保存する', () => {
    const room = roomWith(code('draw', true, [['draw_tiles', 2]])), before = tiles(room);
    const expected = room.wall.slice(-3).reverse();
    room.advance();
    expect(room.players[1].hand.slice(-3)).toEqual(expected);
    expect(room.players[1].hand).toHaveLength(16);
    expect(tiles(room)).toEqual(before);
    expect(room.programs[0].disabled).toBe(false);
    expect(room.isWinning(1, room.players[1].hand)).toBe(false);
    room.discard(room.players[1], room.players[1].hand.at(-1));
    expect(room.players[1].hand).toHaveLength(15);
  });
  it('指定牌と全手牌を山の底へ戻し、同じ枚数を交換する', () => {
    const room = roomWith(code('speech', true, [['return_hand'], ['draw_tiles', ['get', 'hand_count']]]));
    const before = tiles(room), hand = [...room.players[0].hand], wall = [...room.wall];
    room.speech(room.players[0], '交換');
    expect(room.players[0].hand).toEqual(wall.slice(-hand.length).reverse());
    expect(room.wall.slice(0, hand.length)).toEqual(hand);
    expect(tiles(room)).toEqual(before);
    room.programs = updatePrograms([], verdict(code('speech', true, [['return_tile', ['at', 'hand', 0]]])));
    const tile = room.players[0].hand[0];
    room.speech(room.players[0], '1枚戻す');
    expect(room.wall[0]).toBe(tile);
    expect(room.players[0].hand).toHaveLength(hand.length - 1);
    expect(tiles(room)).toEqual(before);
    expect(tiles(Room.restore(JSON.parse(JSON.stringify(room))))).toEqual(before);
  });
  it('複数コードの移動は同じ山を順番に消費し、式は開始時の状態を読む', () => {
    const program = code('speech', true, [['draw_tiles', 1], ['set', 'n', ['get', 'wall']]]);
    const room = roomWith(program), wall = [...room.wall], before = tiles(room);
    room.programs.push({...structuredClone(room.programs[0]), id: 'second'});
    room.speech(room.players[0], '追加');
    expect(room.players[0].hand.slice(-2)).toEqual(wall.slice(-2).reverse());
    expect(room.programs.map(p => p.memory[0].n)).toEqual([wall.length, wall.length]);
    expect(tiles(room)).toEqual(before);
  });
  it.each([
    [['draw_tiles', 0]], [['draw_tiles', 0.5]], [['draw_tiles', 137]],
    [['draw_tiles', 136]], [['return_tile', 'invalid']], [['delete_tiles', 'hand', -1, 1]],
    [['draw_tiles', 1], ['award', ['/', 1, 0]]],
  ].map(actions => ({actions})))('不正な移動$actionsは牌・点数・カウンタをまとめて取り消す', ({actions}) => {
    const room = roomWith(code('speech', true, [['set', 'n', 1], ['award', 100], ...actions]));
    const hand = [...room.players[0].hand], wall = [...room.wall];
    room.speech(room.players[0], 'テスト');
    expect(room.players[0].hand).toEqual(hand); expect(room.wall).toEqual(wall);
    expect(room.players[0].score).toBe(25000);
    expect(room.programs[0].memory[0]).toEqual({});
    expect(room.programs[0].disabled).toBe(true);
  });
  it('配牌後の大量ツモで後続席の配牌を壊さない', () => {
    const room = roomWith(code('after_deal', true, [['draw_tiles', ['get', 'wall']]]));
    room.status = 'finished'; room.start(room.players[0]);
    expect(room.programs[0].disabled).toBe(true);
    expect(room.players.map(p => p.hand.length)).toEqual([13, 14, 13, 13]);
    expect(tiles(room)).toHaveLength(136);
    expect(tiles(room).every(tile => typeof tile === 'string')).toBe(true);
  });
  it('前のコードが最後の山牌を消費しても次のコードだけを取り消す', () => {
    const room = roomWith(code('speech', true, [['draw_tiles', 1]]));
    room.wall = ['1m'];
    room.programs.push({...structuredClone(room.programs[0]), id: 'second'});
    const count = room.players[0].hand.length;
    room.speech(room.players[0], '追加');
    expect(room.players[0].hand).toHaveLength(count + 1);
    expect(room.wall).toEqual([]);
    expect(room.programs.map(p => !!p.disabled)).toEqual([false, true]);
  });
  it('ロン・鳴き待ちは牌操作で解除し、照会・得点計算・打牌前の移動は禁止する', () => {
    const room = roomWith(code('speech', true, [['draw_tiles', 1]]));
    room.claim = {from: 0, tile: '1m', passed: [], deadline: Date.now() / 1000 + 8};
    const before = tiles(room); room.speech(room.players[1], 'ツモ');
    expect(tiles(room)).toEqual(before); expect(room.programs[0].disabled).toBe(false);
    expect(room.claim).toBe(null); expect(room.turn).toBe(1);
    for (const event of ['win_check', 'before_score', 'after_score', 'before_discard', 'before_draw']) {
      expect(() => compile(code(event, true, [['draw_tiles', 1]]))).toThrow();
    }
  });
});

describe('任意の牌プールの操作', () => {
  const fullCount = room => room.wall.length + room.players.reduce((n, p) => n + p.hand.length + p.river.length + p.melds.flatMap(m => m.tiles).length, 0);
  const install = (room, actions, on = 'speech') => {
    room.programs = updatePrograms([], verdict(code(on, true, actions)));
  };
  it('他人の手牌を取り、さらに別の人へ渡す。内容は本人以外に配信しない', () => {
    const room = roomWith(code('speech', true, [
      ['move_tiles', ['hand', 1], 'hand', 0, 2],
      ['move_tiles', 'hand', ['hand', ['%', ['+', ['get', 'actor'], 2], 4]], 0, 1],
    ]));
    const before = fullCount(room), stolen = room.players[1].hand.slice(0, 2), given = room.players[0].hand[0];
    room.speech(room.players[0], '移す');
    expect(room.players[0].hand.slice(-2)).toEqual(stolen);
    expect(room.players[0].hand).toHaveLength(15);
    expect(room.players[1].hand).toHaveLength(11);
    expect(room.players[2].hand.at(-1)).toBe(given);
    expect(fullCount(room)).toBe(before);
    expect(room.snapshot(room.players[3]).players[0]).not.toHaveProperty('hand');
    expect(room.snapshot(room.players[0]).hand).toEqual(room.players[0].hand);
  });
  it('捨て牌を手牌と山へ移動し、コピーと削除で総数を増減する', () => {
    const room = roomWith(code('speech', true, [
      ['move_tiles', ['river', 1], 'hand', 0, 1],
      ['move_tiles', ['river', 1], 'wall_tiles', 0, 1],
      ['copy_tiles', 'hand', ['river', 2], 0, 3],
      ['delete_tiles', ['river', 2], 1, 1],
    ]));
    room.players[1].river = ['5z', '6z'];
    const before = fullCount(room), first = room.players[0].hand.slice(0, 3);
    room.speech(room.players[0], 'プール');
    expect(room.players[0].hand.at(-1)).toBe('5z');
    expect(room.wall[0]).toBe('6z');
    expect(room.players[1].river).toEqual([]);
    expect(room.players[2].river).toEqual([first[0], first[2]]);
    expect(fullCount(room)).toBe(before + 2);
    expect(room.programs[0].disabled).toBe(false);
  });
  it.each(['chi', 'pon', 'kan'])('%sの晒した牌を移動・コピー・削除できる', type => {
    const room = roomWith(code('speech', true, [
      ['copy_tiles', ['meld', 1, 0], ['hand', 2], 0, 1],
      ['move_tiles', ['melds', 1], 'hand', 0, 1],
      ['delete_tiles', ['meld', 1, 0], 0, 1],
    ]));
    const exposed = type === 'chi' ? ['1m', '2m', '3m'] : Array(type === 'kan' ? 4 : 3).fill('5z');
    room.players[1].melds = [{type, tiles: [...exposed], from: 3}];
    const before = fullCount(room);
    room.speech(room.players[0], '副露を操作');
    expect(room.players[0].hand.at(-1)).toBe(exposed[0]);
    expect(room.players[2].hand.at(-1)).toBe(exposed[0]);
    expect(room.players[1].melds[0].tiles).toEqual(exposed.slice(2));
    expect(fullCount(room)).toBe(before);
  });
  it('副露全体の範囲は複数面子にまたがり、空グループを除去する', () => {
    const room = roomWith(code('speech', true, [
      ['move_tiles', ['melds', 1], ['melds', 2], 1, 4],
      ['delete_tiles', ['melds', 1], 0, 1],
    ]));
    room.players[1].melds = [{type: 'chi', tiles: ['1m', '2m', '3m'], from: 0}, {type: 'pon', tiles: ['5z', '5z', '5z'], from: 0}];
    room.speech(room.players[0], '公開牌');
    expect(room.players[1].melds).toEqual([{type: 'pon', tiles: ['5z'], from: 0}]);
    expect(room.players[2].melds).toEqual([{type: 'exposed', tiles: ['2m', '3m', '5z', '5z'], from: 0}]);
    expect(Room.restore(JSON.parse(JSON.stringify(room))).players[2].melds).toEqual(room.players[2].melds);
    expect(room.snapshot(room.players[3]).players[2].melds).toEqual(room.players[2].melds);
  });
  it('壊れた副露では通常のあがりを拒否し、修復すると再び許可する', () => {
    const room = roomWith(code('speech', true, [['move_tiles', ['meld', 0, 0], 'wall_tiles', 0, 1]]));
    const p = room.players[0];
    p.hand = '1m 2m 3m 4m 5m 6m 7p 8p 9p 1z 1z'.split(' ');
    p.melds = [{type: 'pon', tiles: ['5z', '5z', '5z'], from: 1}];
    expect(room.isWinning(0, p.hand)).toBe(true);
    room.speech(p, '副露から戻す');
    expect(room.isWinning(0, p.hand)).toBe(false);
    install(room, [['move_tiles', 'wall_tiles', ['meld', 0, 0], ['-', ['get', 'wall'], 1], 1]]);
    room.speech(p, '修復');
    expect(room.isWinning(0, p.hand)).toBe(true);
    expect(p.melds[0].tiles).toEqual(['5z', '5z', '5z']);
  });
  it('同じプール内でも移動・コピーし、操作後の状態を次の操作で使う', () => {
    const room = roomWith(code('speech', true, [
      ['move_tiles', 'hand', 'hand', 0, 1],
      ['copy_tiles', 'hand', 'hand', 1, 1],
      ['delete_tiles', 'hand', 0, 1],
    ]));
    const before = [...room.players[0].hand];
    room.speech(room.players[0], '並べ替え');
    expect(room.players[0].hand).toEqual([...before.slice(2), before[0], before[2]]);
  });
  it('sizeとindex_ofで他人の手牌・個別副露を選択する', () => {
    const room = roomWith(code('speech', true, [
      ['set', 'size', ['size', ['hand', 1]]],
      ['set', 'found', ['index_of', ['meld', 1, 0], '5z']],
      ['set', 'notfound', ['index_of', ['melds', 1], '1m']],
      ['set', 'rank', ['rank', ['at', ['hand', 1], 0]]],
    ]));
    room.players[1].melds = [{type: 'pon', tiles: ['5z', '5z', '5z'], from: 0}];
    room.speech(room.players[0], '参照');
    expect(room.programs[0].memory[0]).toEqual({size: 13, found: 0, notfound: -1, rank: Number(room.players[1].hand[0][0])});
  });
  it('全手牌の削除を許可し、人間もNPCも空の打牌手番から進める', () => {
    for (const npc of [false, true]) {
      const room = roomWith(code('speech', true, [['delete_tiles', 'hand', 0, ['get', 'hand_count']]]));
      room.players[0].npc = npc;
      room.speech(room.players[0], '全削除');
      expect(room.players[0].hand).toEqual([]);
      expect(room.snapshot(room.players[0]).can_discard).toBe(false);
      expect(room.tick()).toBe(true);
      expect(room.turn).toBe(1);
      expect(room.status).toBe('playing');
    }
  });
  it('打牌後に河の牌を取得し、古いロン・鳴きの申請を残さない', () => {
    const room = roomWith(code('discard', true, [['move_tiles', 'river', ['hand', 2], ['-', ['size', 'river'], 1], 1]]));
    const tile = room.players[0].hand[0], count = room.players[2].hand.length;
    room.discard(room.players[0], tile);
    expect(room.claim).toBe(null);
    expect(room.turn).toBe(1);
    expect(room.players[0].river).toEqual([]);
    expect(room.players[2].hand).toHaveLength(count + 1);
    expect(room.players[2].hand.at(-1)).toBe(tile);
  });
  it('後続コードの失敗は全員の手牌・河・副露・山と先行副作用を一括で取り消す', () => {
    const room = roomWith(code('speech', true, [
      ['set', 'n', 1], ['award', 100],
      ['move_tiles', ['hand', 1], ['melds', 2], 0, 1],
      ['copy_tiles', ['melds', 2], 'wall_tiles', 0, 1],
      ['delete_tiles', ['river', 3], 0, 1],
    ]));
    const before = room.players.map(p => structuredClone({hand: p.hand, river: p.river, melds: p.melds, score: p.score})), wall = [...room.wall];
    room.speech(room.players[0], '取消');
    expect(room.players.map(p => ({hand: p.hand, river: p.river, melds: p.melds, score: p.score}))).toEqual(before);
    expect(room.wall).toEqual(wall);
    expect(room.programs[0].memory[0]).toEqual({});
    expect(room.programs[0].disabled).toBe(true);
  });
  it('コピーの蓄積をプール136枚と卓全体1024枚で制限する', () => {
    const room = roomWith(code('speech', true, [['copy_tiles', 'hand', 'hand', 0, 1]]));
    room.players[0].hand = Array(136).fill('5z');
    const before = fullCount(room);
    room.speech(room.players[0], '増やす');
    expect(fullCount(room)).toBe(before); expect(room.programs[0].disabled).toBe(true);
    room.players.forEach(p => { p.hand = Array(120).fill('5z'); p.river = Array(120).fill('5z'); });
    room.wall = Array(64).fill('5z');
    install(room, [['copy_tiles', 'wall_tiles', 'hand', 0, 1]]);
    room.speech(room.players[0], '上限');
    expect(fullCount(room)).toBe(1024); expect(room.programs[0].disabled).toBe(true);
  });
  it('配牌途中で未配牌席へ渡した牌も通常の配牌と一緒に保持する', () => {
    const room = roomWith(code('after_deal', ['==', ['get', 'actor'], 0], [
      ['move_tiles', 'hand', ['hand', 3], 0, 1],
    ]));
    room.status = 'finished'; room.start(room.players[0]);
    expect(room.players.map(p => p.hand.length)).toEqual([12, 14, 13, 14]);
    expect(fullCount(room)).toBe(136);
    expect(room.programs[0].disabled).toBe(false);
  });
  it('読み取り専用コレクションへの書き込みや不正な副露位置を拒否する', () => {
    for (const target of ['scores', 'discards', 'tokens', ['tokens', 0]]) {
      expect(() => compile(code('speech', true, [['move_tiles', 'hand', target, 0, 1]]))).toThrow();
    }
    const room = roomWith(code('speech', true, [['delete_tiles', ['meld', 1, 0], 0, 1]]));
    room.speech(room.players[0], 'ない副露');
    expect(room.programs[0].disabled).toBe(true);
  });
});
