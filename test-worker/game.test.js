import {describe, it, expect} from 'vitest';
import {Room, DEFAULT_RULES, TILES, winning, validateRules} from '../worker/game.js';
const hand = text => text.split(' ');
function started() {
  const room = new Room('ABCDE');
  for (let i = 0; i < 4; i++) room.join(`人${i}`).ready = true;
  room.start(room.players[0]);
  return room;
}
describe('麻雀の判定と対局', () => {
  it('136枚を重複・欠落なく配り、他人の手牌とトークンを隠す', () => {
    const room = started();
    expect(room.players.map(p => p.hand.length)).toEqual([14, 13, 13, 13]);
    expect([...room.wall, ...room.players.flatMap(p => p.hand)].sort()).toEqual(Array.from({length: 4}, () => TILES).flat().sort());
    const view = room.snapshot(room.players[1]);
    expect(view.hand).toEqual(room.players[1].hand);
    expect(view.players.every(p => !('hand' in p) && !('token' in p))).toBe(true);
  });
  it('通常形・七対子・国士未対応を判定する', () => {
    expect(winning(hand('1m 2m 3m 4m 5m 6m 2p 3p 4p 7s 8s 9s 1z 1z'))).toBe(true);
    const pairs = hand('1m 1m 3m 3m 5p 5p 7p 7p 4s 4s 2z 2z 3z 3z');
    expect(winning(pairs)).toBe(true);
    expect(winning(pairs, 'standard')).toBe(false);
    expect(winning(hand('1m 1m 1m 1m 5p 5p 7p 7p 4s 4s 2z 2z 3z 3z'))).toBe(false);
    expect(winning(hand('1m 9m 1p 9p 1s 9s 1z 2z 3z 4z 5z 6z 7z 7z'))).toBe(false);
  });
  it('先頭より前のジョーカーを使う順子と雀頭を扱う', () => {
    const tiles = hand('5z 2m 3m 4m 5m 6m 2p 3p 4p 7s 8s 9s 1z 1z');
    expect(winning(tiles)).toBe(false);
    expect(winning(tiles, 'default', '5z')).toBe(true);
    expect(winning(hand('5z 5z 3m 4m 5m 6m 2p 3p 4p 7s 8s 9s 1z 1z'), 'default', '5z')).toBe(true);
  });
  it('ルール変更で同じ手があがれ、得点総計を保存する', () => {
    const room = started(), p = room.players[0];
    p.hand = hand('1m 1m 3m 5m 7m 9m 2p 4p 6p 8p 1s 3s 5s 7s');
    expect(() => room.win(p, 'tsumo')).toThrow();
    room.programs = [{id: 'pair-score', code: JSON.stringify([{on: 'win_check', when: true, do: [['win']]}, {on: 'before_score', when: true, do: [['add_points', 6000]]}]), memory: [{}, {}, {}, {}]}];
    room.win(p, 'tsumo');
    expect(room.result.deltas).toEqual([12000, -4000, -4000, -4000]);
    expect(room.players.reduce((sum, q) => sum + q.score, 0)).toBe(100000);
  });
  it('順番違反を拒否し、ロン受付と逆回りを反映する', () => {
    const room = started();
    expect(() => room.discard(room.players[1], room.players[1].hand[0])).toThrow();
    room.direction = -1;
    room.programs = [{id: 'pair', code: JSON.stringify([{on: 'win_check', when: true, do: [['win']]}]), memory: [{}, {}, {}, {}]}];
    room.players[1].hand = hand('1m 1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 2p 3p');
    room.discard(room.players[0], room.players[0].hand.at(-1));
    expect(room.canRon(1)).toBe(true);
    room.win(room.players[1], 'ron');
    expect(room.result.deltas).toEqual([-6000, 6000, 0, 0]);
    room.start(room.players[0]); room.discard(room.players[1], room.players[1].hand.at(-1));
    if (room.claim) { room.claim.deadline = 0; room.tick(); }
    expect(room.turn).toBe(0);
  });
  it('不正なAIルールを拒否する', () => {
    for (const patch of [{win_points: 999999}, {turn_seconds: true}, {joker: '../apikey.local'}, {speech_keyword: 'a'.repeat(21)}]) {
      expect(() => validateRules({...DEFAULT_RULES, ...patch})).toThrow();
    }
    expect(() => validateRules({...DEFAULT_RULES, extra: true})).toThrow();
  });
  it('合言葉のボーナスと即あがりを処理する', () => {
    const room = started(); room.rules.speech_keyword = 'ポテト';
    room.speech(room.players[0], 'ポテト');
    expect(room.players.map(p => p.score)).toEqual([25900, 24700, 24700, 24700]);
    room.rules.speech_effect = 'win'; room.speech(room.players[1], 'ポテト');
    expect(room.status).toBe('finished');
    expect(room.result.winner).toBe(1);
    expect(room.players.reduce((sum, p) => sum + p.score, 0)).toBe(100000);
  });
});
