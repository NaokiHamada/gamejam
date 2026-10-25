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
