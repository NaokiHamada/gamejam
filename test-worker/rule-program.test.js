import {describe, it, expect} from 'vitest';
import {compile, execute, LIMITS} from '../worker/rule-program.js';
import {Room, DEFAULT_RULES} from '../worker/game.js';
import {validateVerdict, updatePrograms, penalty} from '../worker/referee.js';

const code = (on, when, actions) => JSON.stringify([{on, when, do: actions}]);
const verdict = program => ({accepted: true, violation: 'none', severity: 0, title: '自由ルール', explanation: '発動条件と効果',
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
    expect(room.rules.reverse_order).toBe(true);
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
    expect(room.rules.turn_seconds).toBe(45);
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
