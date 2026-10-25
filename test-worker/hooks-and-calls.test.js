import {describe, it, expect} from 'vitest';
import {Room, DEFAULT_RULES, TILES, winning} from '../worker/game.js';
import {compile, EVENTS, LIMITS} from '../worker/rule-program.js';

const tiles = text => text.split(' ');
const losing = tiles('1m 3m 5m 7m 9m 1p 3p 5p 7p 9p 1s 3s 5s');
const hook = (on, actions, when = true) => ({on, when, do: actions});
const get = field => ['get', field];
function program(room, hooks) {
  const code = JSON.stringify(hooks); compile(code);
  room.programs = [{id: 'hooks', title: 'フック', code, memory: [{}, {}, {}, {}]}];
  return room.programs[0];
}
function lobby() {
  const room = new Room('ABCDE');
  for (let i = 0; i < 4; i++) room.join(`人${i}`).ready = true;
  return room;
}
function claimRoom(tile = '5z') {
  const room = lobby(); room.start(room.players[0]);
  for (const p of room.players) { p.hand = [...losing]; p.river = []; }
  room.players[0].river.push(tile);
  room.claim = {tile, from: 0, passed: [], requests: [], deadline: Date.now() / 1000 + 8};
  room.drawn = false;
  return room;
}
const memory = room => room.programs[0].memory;

describe('処理前後の生成フック', () => {
  it('直近2ステップのみに新コードを適用し、通常ツモと既存コードは繰り返さない', () => {
    const room = lobby(); room.start(room.players[0]);
    const old = program(room, [hook('after_draw', [['award', 100]])]);
    room.changeTurn(1); room.draw();
    const wall = room.wall.length, hands = room.players.map(p => [...p.hand]);
    const scores = room.players.map(p => p.score);
    const added = {id: 'new', title: '新ルール', memory: [{}, {}, {}, {}], code: JSON.stringify([
      hook('after_draw', [['award', 200], ['draw_tiles', 1]])])};
    room.programs.push(added);
    room.applyAdoptedProgram(added);
    expect(room.recent_events).toHaveLength(4);
    expect(room.players[0].hand).toEqual(hands[0]);
    expect(room.players[1].hand).toHaveLength(hands[1].length + 1);
    expect(room.wall).toHaveLength(wall - 1);
    expect(room.players.map((p, i) => p.score - scores[i])).toEqual([-200, 600, -200, -200]);
    expect(old.disabled).not.toBe(true);
    room.status = 'finished'; room.start(room.players[0]);
    expect(room.recent_events.map(e => e.seat)).toEqual([1, 1]);
  });
  it('履歴のない旧保存データも復元でき、過去のイベントを捏造しない', () => {
    const original = lobby(); original.start(original.players[0]);
    const data = structuredClone(original); delete data.recent_events;
    const room = Room.restore(data);
    const added = program(room, [hook('after_draw', [['draw_tiles', 1]])]);
    const wall = room.wall.length;
    room.applyAdoptedProgram(added);
    expect(room.wall).toHaveLength(wall);
    expect(room.recent_events).toEqual([]);
  });
  it('開局・配牌は各席、最初のツモは親だけに処理前後の状態を渡す', () => {
    const room = lobby();
    program(room, [
      hook('before_round_start', [['set', 'start', get('wall')]]),
      hook('before_deal', [['set', 'before', get('hand_count')], ['set', 'wall', get('wall')]]),
      hook('after_deal', [['set', 'after', get('hand_count')]]),
      hook('after_round_start', [['set', 'ready', get('wall')]]),
      hook('before_draw', [['set', 'pre', get('hand_count')]]),
      hook('after_draw', [['set', 'post', get('hand_count')]])]);
    room.start(room.players[0]);
    expect(memory(room)[0]).toMatchObject({start: 136, before: 0, wall: 136, after: 13, ready: 84, pre: 13, post: 14});
    expect(memory(room)[3]).toMatchObject({start: 136, before: 0, wall: 97, after: 13, ready: 84});
    expect(memory(room)[1]).not.toHaveProperty('pre');
    room.status = 'finished'; room.start(room.players[0]);
    expect(room.players.every(p => !p.melds.length)).toBe(true);
    expect(memory(room)[0].before).toBe(0);
  });
  it('打牌と手番交代の前後を観測し、従来のdraw/discardとも互換性を保つ', () => {
    const room = lobby(); room.start(room.players[0]);
    room.players.forEach(p => { p.hand = [...losing]; }); room.players[0].hand.push('7z');
    program(room, [hook('before_discard', [['set', 'pre', get('hand_count')]]),
      hook('discard', [['set', 'post', get('hand_count')]]),
      hook('before_turn', [['set', 'old', get('turn')]]), hook('after_turn', [['set', 'new', get('turn')]]),
      hook('draw', [['set', 'drawn', get('hand_count')]])]);
    room.discard(room.players[0], '7z');
    expect(memory(room)[0]).toMatchObject({pre: 14, post: 13});
    expect(memory(room)[1]).toMatchObject({old: 0, new: 1, drawn: 14});
  });
  it('安全な発言の前後で合言葉の得点移動を挟み、採用判定待ちでは実行しない', () => {
    const room = lobby(); room.start(room.players[0]); room.rules.speech_keyword = '白';
    program(room, [hook('before_speech', [['set', 'before', get('score')]]), hook('speech', [['set', 'after', get('score')]])]);
    room.speech(room.players[0], '白', true); expect(memory(room)[0]).toEqual({});
    room.speechEffects(room.players[0], '白');
    expect(memory(room)[0]).toEqual({before: 25000, after: 25900});
  });
  it('点数計算の前後と旧補正を順に適用し、支払い前の点と放銃席を渡す', () => {
    const room = lobby(); room.start(room.players[0]);
    program(room, [hook('before_score', [['set', 'base', get('points')], ['add_points', 1000]]),
      hook('win_score', [['add_points', 500]]),
      hook('after_score', [['set', 'calculated', get('points')], ['set', 'loser', get('loser')], ['add_points', ['*', get('points'), 1]]])]);
    room.finish(0, 2, ['1z'], 'ロン');
    expect(memory(room)[0]).toEqual({base: 6000, calculated: 7500, loser: 2});
    expect(room.result.deltas).toEqual([15000, 0, -15000, 0]);
    expect(room.players.reduce((n, p) => n + p.score, 0)).toBe(100000);
  });
  it('点数を各段階で制限し、計算失敗でそのコードの変数と補正を取り消す', () => {
    const room = lobby(); room.start(room.players[0]);
    program(room, [hook('before_score', [['add_points', 24000]]), hook('after_score', [['add_points', 24000]])]);
    room.rules.bonus_suit = 'z'; room.rules.bonus_points = 2000;
    room.finish(0, 1, Array(14).fill('1z'), 'ロン'); expect(room.result.deltas[0]).toBe(60000);
    room.status = 'playing';
    program(room, [hook('before_score', [['set', 'n', 1], ['add_points', ['/', 100, 0]]])]);
    room.finish(0, 1, [], 'ロン');
    expect(room.programs[0].disabled).toBe(true); expect(memory(room)[0]).toEqual({});
    expect(room.result.deltas[0]).toBe(6000);
  });
  it('新イベントを検証し、処理前の即あがり・得点以外の補正・上限超過を拒否する', () => {
    for (const event of EVENTS.filter(e => !['win_check', 'win_score'].includes(e))) {
      expect(() => compile(JSON.stringify([hook(event, [['set', 'n', 1]])]))).not.toThrow();
    }
    for (const event of ['before_draw', 'before_call', 'after_call', 'before_score', 'after_score']) {
      expect(() => compile(JSON.stringify([hook(event, [['win']])]))).toThrow();
    }
    expect(() => compile(JSON.stringify([hook('after_deal', [['add_points', 100]])]))).toThrow();
    expect(() => compile(JSON.stringify(Array.from({length: LIMITS.hooks + 1}, () => hook('after_draw', [['set', 'n', 1]]))))).toThrow();
  });
  it('ツモ後の即あがりで打牌後の次手番へ進まない', () => {
    const room = claimRoom(); room.claim = null; room.drawn = true; room.players[0].hand.push('7z');
    program(room, [hook('after_draw', [['win']])]);
    room.discard(room.players[0], '7z'); expect(room.result.winner).toBe(1); expect(room.turn).toBe(1);
    room.advance(); expect(room.turn).toBe(1);
  });
});

describe('チー・ポン・大明槓と鳴きフック', () => {
  it.each([['pon', 2, 11], ['kan', 3, 11]])('%sで牌を移し、カンだけ補充ツモする', (type, count, expected) => {
    const room = claimRoom(); room.players[1].hand = [...Array(count).fill('5z'), ...losing.slice(count)];
    const originalWall = room.wall.length;
    program(room, [hook('before_call', [['set', 'before', get('hand_count')], ['set', 'source', get('source')]]),
      hook('after_call', [['set', 'after', get('hand_count')], ['set', 'melds', get('meld_count')], ['award', 100]])]);
    room.action('call', room.players[1], {type, tiles: Array(count).fill('5z')});
    expect(room.turn).toBe(1); expect(room.claim).toBe(null);
    expect(room.players[1].hand).toHaveLength(expected);
    expect(room.players[1].melds[0]).toMatchObject({type, from: 0, tiles: Array(count + 1).fill('5z')});
    expect(room.players[0].river).toEqual([]);
    expect(room.wall.length).toBe(originalWall - Number(type === 'kan'));
    expect(memory(room)[1]).toEqual({before: 13, source: 0, after: 13 - count, melds: 1});
    expect(room.players[1].score).toBe(25300);
    expect(room.snapshot(room.players[2]).players[1].melds).toEqual(room.players[1].melds);
    expect(Room.restore(JSON.parse(JSON.stringify(room))).players[1].melds).toEqual(room.players[1].melds);
  });
  it.each([['chi', '3m', ['1m', '2m']], ['pon', '5z', ['5z', '5z']], ['kan', '5z', ['5z', '5z', '5z']]])(
    '%sの前後で136枚を重複・欠落なく保存する', (type, tile, owned) => {
      const room = lobby(); room.start(room.players[0]);
      const deck = Array.from({length: 4}, () => TILES).flat();
      const take = tile => deck.splice(deck.indexOf(tile), 1)[0];
      const host = [take(tile)], caller = owned.map(take);
      while (host.length < 14) host.push(deck.pop());
      while (caller.length < 13) caller.push(deck.pop());
      room.players[0].hand = host; room.players[1].hand = caller;
      room.players[2].hand = deck.splice(0, 13); room.players[3].hand = deck.splice(0, 13); room.wall = deck;
      const inventory = () => [...room.wall, ...room.players.flatMap(p => [...p.hand, ...p.river, ...p.melds.flatMap(m => m.tiles)])].sort();
      const before = inventory(); expect(before).toHaveLength(136);
      room.discard(room.players[0], tile); room.call(room.players[1], type, owned); room.resolveClaim(true);
      expect(inventory()).toEqual(before); expect(room.turn).toBe(1);
    });
  it('NPCも待ち時間後に鳴きを申請し、AI判定中は停止する', () => {
    const room = claimRoom(); room.players[1].npc = true; room.players[1].hand = ['5z', '5z', ...losing.slice(2)];
    room.npc_deadline = 0; room.pending = true; expect(room.tick()).toBe(false);
    room.pending = false; expect(room.tick()).toBe(true);
    expect(room.players[1].melds[0].type).toBe('pon'); expect(room.turn).toBe(1); expect(room.drawn).toBe(false);
    expect(room.ai_calls).toBe(0);
  });
  it('チーは次席の順子だけで、逆回りにも従う', () => {
    const room = claimRoom('3m');
    room.players[1].hand = tiles('1m 2m 4m 5m 1p 3p 5p 7p 9p 1s 3s 5s 7z');
    expect(room.callOptions(1).filter(o => o.type === 'chi')).toHaveLength(3);
    expect(room.callOptions(2)).toEqual([]);
    room.direction = -1;
    expect(room.callOptions(1).filter(o => o.type === 'chi')).toEqual([]);
    room.players[3].hand = [...room.players[1].hand];
    room.call(room.players[3], 'chi', ['4m', '2m']);
    expect(room.players[3].melds[0].tiles).toEqual(['2m', '3m', '4m']);
    expect(room.turn).toBe(3);
    expect(room.drawn).toBe(false);
  });
  it('ポンは申請順にかかわらずチーより優先し、確定時にだけフックを実行する', () => {
    const room = claimRoom('3m'); room.players[1].hand = [...losing]; room.players[1].hand[1] = '2m';
    room.players[2].hand = ['3m', '3m', ...losing.slice(2)];
    program(room, [hook('after_call', [['set', 'n', 1]])]);
    room.call(room.players[1], 'chi', ['1m', '2m']);
    expect(room.claim).not.toBe(null); expect(memory(room)[1]).toEqual({});
    room.call(room.players[2], 'pon', ['3m', '3m']);
    expect(room.turn).toBe(2); expect(memory(room)[2].n).toBe(1); expect(memory(room)[1]).toEqual({});
  });
  it('ロンを鳴きより優先し、見送り・締切で鳴きを確定する', () => {
    const room = claimRoom('5z'); room.players[1].hand = ['5z', '5z', ...losing.slice(2)];
    room.players[2].hand = tiles('1m 2m 3m 4m 5m 6m 2p 3p 4p 7s 8s 9s 5z');
    room.call(room.players[1], 'pon', ['5z', '5z']);
    expect(room.claim).not.toBe(null); room.win(room.players[2], 'ron');
    expect(room.result.winner).toBe(2); expect(room.players[1].melds).toEqual([]);
    const other = claimRoom(); other.players[1].hand = ['5z', '5z', ...losing.slice(2)];
    other.players[2].hand = [...room.players[2].hand];
    other.call(other.players[1], 'pon', ['5z', '5z']); other.action('pass', other.players[2], {});
    expect(other.turn).toBe(1); expect(other.claim).toBe(null);
    const expired = claimRoom(); expired.players[1].hand = ['5z', '5z', ...losing.slice(2)];
    expired.players[2].hand = [...room.players[2].hand];
    expired.call(expired.players[1], 'pon', ['5z', '5z']); expired.claim.deadline = 0; expired.tick();
    expect(expired.turn).toBe(1); expect(expired.players[1].melds).toHaveLength(1);
  });
  it('鳴き不可・AI待機・重複申請を拒否し、失敗時はフックも動かない', () => {
    const room = claimRoom(); room.players[1].hand = ['5z', '5z', ...losing.slice(2)];
    room.players[2].hand = ['5z', '5z', ...losing.slice(2)];
    program(room, [hook('before_call', [['set', 'n', 1]])]);
    const before = JSON.stringify(room); expect(() => room.call(room.players[1], 'pon', ['5z', '7z'])).toThrow();
    expect(JSON.stringify(room)).toBe(before);
    room.pending = true; expect(() => room.call(room.players[1], 'pon', ['5z', '5z'])).toThrow(); room.pending = false;
    room.call(room.players[1], 'pon', ['5z', '5z']);
    expect(() => room.call(room.players[1], 'pon', ['5z', '5z'])).toThrow();
    expect(memory(room)[1]).toEqual({});
    room.wall = []; expect(room.callOptions(2).some(o => o.type === 'kan')).toBe(false);
  });
  it('副露を固定面子として判定し、七対子に組み替えず、鳴き直後のツモあがりを拒否する', () => {
    const melds = [{type: 'pon', tiles: ['5z', '5z', '5z'], from: 0}];
    const hand = tiles('1m 2m 3m 4m 5m 6m 7p 8p 9p 1z 1z');
    expect(winning(hand, 'default', 'none', melds)).toBe(true);
    expect(winning(hand.slice(1), 'default', 'none', melds)).toBe(false);
    const room = claimRoom(); room.claim = null; room.turn = 1; room.drawn = false;
    room.players[1].hand = hand; room.players[1].melds = melds;
    expect(room.snapshot(room.players[1]).can_tsumo).toBe(false);
    expect(() => room.win(room.players[1], 'tsumo')).toThrow();
    room.drawn = true; room.win(room.players[1], 'tsumo'); expect(room.result.hand).toHaveLength(14);
    expect(room.result.deltas.reduce((a, b) => a + b)).toBe(0);
  });
  it('副露後の独自あがり判定の照会で状態を変えず、全牌のボーナスを計算する', () => {
    const room = claimRoom(); room.claim = null; room.turn = 1; room.drawn = true;
    room.players[1].melds = [{type: 'kan', tiles: Array(4).fill('5z'), from: 0}]; room.players[1].hand = losing.slice(0, 11);
    program(room, [hook('win_check', [['win']], ['==', get('meld_count'), 1])]);
    const before = JSON.stringify(room); expect(room.snapshot(room.players[1]).can_tsumo).toBe(true); expect(JSON.stringify(room)).toBe(before);
    room.rules.bonus_suit = 'z'; room.win(room.players[1], 'tsumo');
    expect(room.result.hand).toHaveLength(15); expect(room.result.deltas[1]).toBe(8100);
  });
});
