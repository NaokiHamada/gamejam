import {describe, it, expect} from 'vitest';
import {compile, LIMITS} from '../worker/rule-program.js';
import {Room, DEFAULT_RULES} from '../worker/game.js';
import {validateVerdict, updatePrograms} from '../worker/referee.js';

const split = text => text.split(' ');
const losing = split('1m 3m 5m 7m 9m 1p 3p 5p 7p 9p 1s 3s 5s');
const verdict = (code, id = 'custom', mode = 'add') => ({accepted: true, justification: 'sufficient', violation: 'none', severity: 0,
  title: '自由ルール', explanation: '発動条件と効果', rules: {...DEFAULT_RULES}, program: {mode, id, code}});
function roomWith(...codes) {
  const room = new Room('ABCDE');
  for (let i = 0; i < 4; i++) room.join(`人${i}`).ready = true;
  room.start(room.players[0]);
  room.programs = codes.reduce((programs, code, n) => updatePrograms(programs, validateVerdict(verdict(code, `rule${n}`))), []);
  return room;
}
const inventory = room => [...room.wall, ...room.players.flatMap(p => [...p.hand, ...p.river, ...p.melds.flatMap(m => m.tiles)])].sort();
const total = room => room.players.reduce((n, p) => n + p.score, 0);

describe('JavaScriptの生成ルール', () => {
  it('発言カウンタをコードごとに保持し、3回目だけ加点して局をまたいで復元する', () => {
    const room = roomWith(`on('speech', (g, e) => {
      const key = 'n' + e.actor; g.memory[key] = (g.memory[key] || 0) + 1;
      if (g.memory[key] % 3 === 0) g.award(e.actor, 300);
    });`);
    for (let i = 0; i < 3; i++) room.speech(room.players[1], '話す');
    room.speech(room.players[2], '話す');
    expect(room.programs[0].memory).toEqual({n1: 3, n2: 1});
    expect(room.players.map(p => p.score)).toEqual([24700, 25900, 24700, 24700]);
    const restored = Room.restore(JSON.parse(JSON.stringify(room)));
    restored.status = 'finished'; restored.start(restored.players[0]);
    expect(restored.programs[0].memory).toEqual({n1: 3, n2: 1});
  });
  it('独自のあがり判定を照会しても状態を変えず、操作時の計算失敗だけ停止する', () => {
    const room = roomWith(`on('win_check', (g, e) => { g.players[1].score = 0; g.memory.seen = true; return e.hand.filter(isHonor).length >= 5; });`);
    room.players[0].hand = split('1z 1z 2z 3z 4z 1m 3m 5m 7m 9m 1p 3p 5p 7p');
    const before = JSON.stringify(room);
    expect(room.snapshot(room.players[0]).can_tsumo).toBe(true);
    expect(JSON.stringify(room)).toBe(before);
    room.win(room.players[0], 'tsumo');
    expect(room.result.winner).toBe(0);
    expect(room.programs[0].memory).toEqual({});

    const broken = roomWith(`on('win_check', (g, e) => e.hand.foo.bar);`);
    expect(broken.snapshot(broken.players[0]).can_tsumo).toBe(false);
    expect(broken.programs[0].disabled).toBe(false);
    expect(() => broken.win(broken.players[0], 'tsumo')).toThrow();
    expect(broken.programs[0].disabled).toBe(true);
  });
  it('通常のツモ後に追加2枚をツモり、再帰せず牌136枚を保存する', () => {
    const room = roomWith(`on('draw', (g, e) => g.draw(e.actor, 2));`), before = inventory(room);
    const expected = room.wall.slice(-3).reverse();
    room.advance();
    expect(room.players[1].hand.slice(-3)).toEqual(expected);
    expect(room.players[1].hand).toHaveLength(16);
    expect(inventory(room)).toEqual(before);
    expect(room.isWinning(1, room.players[1].hand)).toBe(false);
  });
  it('失敗したコードの牌・点数・記録だけを取り消し、前のコードの変更は残す', () => {
    const room = roomWith(`on('speech', (g, e) => g.draw(e.actor));`,
      `on('speech', (g, e) => { g.memory.n = 1; g.award(e.actor, 100); g.players[1].hand = []; g.wall.length = 0; throw new Error('bug'); });`);
    const hand = [...room.players[0].hand], next = room.wall.at(-1);
    room.speech(room.players[0], 'テスト');
    expect(room.players[0].hand).toEqual([...hand, next]);
    expect(room.players[1].hand).toHaveLength(13);
    expect(room.players.map(p => p.score)).toEqual([25000, 25000, 25000, 25000]);
    expect(room.programs.map(p => [p.disabled, p.memory])).toEqual([[false, {}], [true, {}]]);
    expect(room.messages.some(m => m.kind === 'error')).toBe(true);
  });
  it.each([
    ['牌でない文字列', `g.players[0].hand.push('8z')`],
    ['数値でない点数', `g.players[0].score = 'many'`],
    ['山の上限超過', `for (let i = 0; i < 70; i++) g.wall.push(...TILES)`],
    ['不正な進行方向', `g.direction = 2`],
    ['不正な席', `g.pay(0, 4, 100)`],
    ['大きすぎる記録', `g.memory.big = 'x'.repeat(9000)`],
    ['卓の差し替え', `g.players = null`],
    ['山の差し替え', `g.wall = 'none'`],
  ])('%sは変更全体を取り消して停止する', (_, body) => {
    const room = roomWith(`on('speech', (g, e) => { g.award(e.actor, 100); ${body}; });`);
    const state = () => JSON.stringify({players: room.players.map(p => [p.hand, p.score]), wall: room.wall, direction: room.direction});
    const before = state();
    room.speech(room.players[0], 'テスト');
    expect(state()).toBe(before);
    expect(room.programs[0].disabled).toBe(true);
  });
  it('前のコードが補助関数や卓を差し替えても、後のコードは元の卓と補助関数で動く', () => {
    const room = roomWith(`on('speech', (g, e) => { g.players[1].score += 100; g.players[0].score -= 100; g.draw = null; g.turn = 3; });`,
      `on('speech', (g, e) => { g.memory.turn = g.turn; g.draw(e.actor); });`);
    const count = room.players[0].hand.length;
    room.speech(room.players[0], 'テスト');
    expect(room.programs.map(p => p.disabled)).toEqual([false, false]);
    expect(room.programs[1].memory).toEqual({turn: 0});
    expect(room.players[0].hand).toHaveLength(count + 1);
    expect(room.players.map(p => p.score)).toEqual([24900, 25100, 25000, 25000]);
  });
  it('無限ループ・無限再帰は実行量上限で止め、登録時の無限ループも拒否する', () => {
    for (const body of ['while (true) {}', 'for (;;) ;', 'const f = () => f(); f()', '[1].forEach(function loop() { while (1) {} })']) {
      const room = roomWith(`on('speech', (g) => { g.memory.x = 1; ${body}; });`);
      room.speech(room.players[0], 'ループ');
      expect(room.programs[0].disabled).toBe(true);
      expect(room.programs[0].memory).toEqual({});
    }
    expect(() => compile(`while (true) {} on('draw', () => {});`)).toThrow('実行量上限');
    // The interpreter cannot destructure into properties; such code stops when it runs.
    const swap = roomWith(`on('speech', (g) => { [g.players[0].hand, g.players[1].hand] = [g.players[1].hand, g.players[0].hand]; });`);
    swap.speech(swap.players[0], '交換');
    expect(swap.programs[0].disabled).toBe(true);
    expect(() => validateVerdict(verdict(`while (true) {}`))).toThrow('生成コードを実行できません');
    // Ordinary heavy-but-finite work stays within the budget.
    const room = roomWith(`on('speech', (g) => { let n = 0; for (let i = 0; i < 50000; i++) n += i % 7; g.memory.n = n; });`);
    room.speech(room.players[0], '計算');
    expect(room.programs[0]).toMatchObject({disabled: false, memory: {n: 149997}});
  });
  it('配牌後の大量ツモで後続席の配牌を壊さない', () => {
    const room = roomWith(`on('after_deal', (g, e) => g.draw(e.actor, g.wall.length));`);
    room.status = 'finished'; room.start(room.players[0]);
    expect(room.programs[0].disabled).toBe(true);
    // Round 2: seat 1 deals and draws first.
    expect(room.players.map(p => p.hand.length)).toEqual([13, 14, 13, 13]);
    expect(inventory(room)).toHaveLength(136);
  });
  it('ロン・鳴き待ちは牌操作で解除し、次の手番へ進む', () => {
    const room = roomWith(`on('discard', (g, e) => { const river = g.players[e.actor].river; g.players[2].hand.push(river.pop()); });`);
    const tile = room.players[0].hand[0], count = room.players[2].hand.length;
    room.discard(room.players[0], tile);
    expect(room.claim).toBe(null);
    expect(room.turn).toBe(1);
    expect(room.players[0].river).toEqual([]);
    expect(room.players[2].hand).toEqual(expect.arrayContaining([tile]));
    expect(room.players[2].hand).toHaveLength(count + 1);
  });
  it('他人の手牌の交換・乱数シャッフル・お知らせを使え、手牌は本人以外に配信しない', () => {
    const room = roomWith(`on('speech', (g, e) => {
      if (!e.text.includes('交換')) return;
      const other = g.next(e.actor);
      const hand = g.players[e.actor].hand; g.players[e.actor].hand = g.players[other].hand; g.players[other].hand = hand;
      g.shuffle(g.wall); g.say(g.players[e.actor].name + 'が手牌を交換！' + g.random(1));
    });`);
    const mine = [...room.players[0].hand], theirs = [...room.players[1].hand], before = inventory(room);
    room.speech(room.players[0], '交換しよう');
    expect(room.players[0].hand).toEqual(theirs);
    expect(room.players[1].hand).toEqual(mine);
    expect(inventory(room)).toEqual(before);
    expect(room.messages.some(m => m.text === '自由ルール：人0が手牌を交換！0')).toBe(true);
    expect(JSON.stringify(room.snapshot(room.players[2]))).not.toContain(JSON.stringify(theirs));
  });
  it('進行方向と持ち時間を変え、持ち時間は5〜300秒に丸める', () => {
    const room = roomWith(`on('speech', (g) => { g.direction = -g.direction; g.turnSeconds = 'long'; });`);
    room.speech(room.players[0], '逆');
    expect(room.programs[0].disabled).toBe(true);
    expect(room.direction).toBe(1);
    const ok = roomWith(`on('speech', (g) => { g.direction = -1; g.turnSeconds = 999.4; });`);
    ok.speech(ok.players[0], '逆');
    expect([ok.direction, ok.turn_seconds]).toEqual([-1, 300]);
    expect(ok.nextSeat(0)).toBe(3);
  });
});

describe('打牌・鳴きの禁止', () => {
  const code = `on('discard_check', (g, e) => isHonor(e.tile) ? '字牌は捨てられません' : true);`;
  it('禁止した牌の打牌を理由つきで拒否し、全牌禁止ならその手番は制限しない', () => {
    const room = roomWith(code);
    room.players[0].hand = [...losing, '7z'];
    expect(() => room.discard(room.players[0], '7z')).toThrow('字牌は捨てられません');
    expect(room.players[0].hand).toContain('7z');
    room.discard(room.players[0], '1m');
    const stuck = roomWith(code); stuck.players[0].hand = split('1z 2z');
    stuck.discard(stuck.players[0], '2z');
    expect(stuck.players[0].river).toEqual(['2z']);
  });
  it('時間切れとNPCは許可された牌を選ぶ', () => {
    for (const npc of [false, true]) {
      const room = roomWith(code);
      room.players[0].npc = npc;
      room.players[0].hand = [...losing, '7z'];
      room.deadline = 0; room.npc_deadline = 0;
      expect(room.tick()).toBe(true);
      expect(room.players[0].river).toHaveLength(1);
      expect(room.players[0].river[0]).not.toBe('7z');
    }
  });
  it('鳴きを条件で禁止する', () => {
    const room = roomWith(`on('call_check', (g, e) => e.callType !== 'pon');`);
    for (const p of room.players) p.hand = [...losing];
    room.players[1].hand = ['5z', '5z', '5z', ...losing.slice(3)];
    room.players[0].river = ['5z']; room.claim = {tile: '5z', from: 0, passed: [], requests: [], deadline: Date.now() / 1000 + 8};
    expect(room.callOptions(1).map(o => o.type)).toEqual(['kan']);
    expect(() => room.call(room.players[1], 'pon', ['5z', '5z'])).toThrow();
  });
});

describe('得点・支払い・局の終了', () => {
  it('支払いを書き換えて責任払いにできる', () => {
    const room = roomWith(`on('payment', (g, e) => {
      const pao = g.players[e.winner].melds.find(m => m.from !== e.winner)?.from;
      if (e.loser !== -1 || pao === undefined) return;
      const sum = e.deltas[e.winner];
      return e.deltas.map((_, s) => s === e.winner ? sum : s === pao ? -sum : 0);
    });`);
    room.players[1].melds = [{type: 'pon', tiles: ['5z', '5z', '5z'], from: 3}];
    room.finish(1, null, split('1m 2m 3m 4m 5m 6m 7p 8p 9p 1z 1z'), 'ツモ');
    expect(room.result.deltas).toEqual([0, 6000, 0, -6000]);
    expect(total(room)).toBe(100000);
  });
  it('振り込んだ人を記録し、次局のあがり点を倍にする', () => {
    const room = roomWith(`on('round_end', (g, e) => { g.memory.double = e.drawn ? -1 : e.loser; });
      on('win_score', (g, e) => e.winner === g.memory.double ? e.points * 2 : e.points);`);
    room.finish(0, 2, ['1z'], 'ロン');
    expect(room.programs[0].memory).toEqual({double: 2});
    room.start(room.players[0]);
    room.finish(2, 1, ['1z'], 'ロン');
    expect(room.result.deltas).toEqual([0, -12000, 12000, 0]);
    room.start(room.players[0]); room.wall = []; room.draw();
    expect(room.result.winner).toBe(null);
    expect(room.programs[0].memory).toEqual({double: -1});
  });
  it('役・ドラ相当を加点し、役満級の点数も扱う', () => {
    const room = roomWith(`on('win_score', (g, e) => {
      let points = e.points + e.hand.filter(t => rank(t) === 5 && !isHonor(t)).length * 1000;
      if (['5z', '6z', '7z'].every(t => countTile(e.hand, t) >= 3)) points = 96000;
      return points;
    });`);
    room.finish(0, 1, split('5m 5p 5s 1z'), 'ロン');
    expect(room.result.deltas[0]).toBe(9000);
    room.status = 'playing';
    room.finish(0, 1, split('5z 5z 5z 6z 6z 6z 7z 7z 7z 1m 1m'), 'ロン');
    expect(room.result.deltas[0]).toBe(96000);
  });
  it('特定の相手へ支払って追加ツモし、回文の捨て牌で即あがりできる', () => {
    const room = roomWith(`on('speech', (g, e) => {
        if (e.actor === g.dealer && e.text.includes('2枚ツモ') && e.actor === g.turn) { g.pay(e.actor, g.next(e.actor), 1000); g.draw(e.actor); }
      });
      on('discard', (g, e) => {
        const r = g.players[e.actor].river;
        if (r.length >= 3 && r.join() === [...r].reverse().join()) g.win(e.actor, '回文あがり');
      });`);
    const count = room.players[0].hand.length;
    room.speech(room.players[0], '2枚ツモ！');
    expect(room.players[0].hand).toHaveLength(count + 1);
    expect(room.players.map(p => p.score)).toEqual([24000, 26000, 25000, 25000]);
    room.players[0].river = ['1m', '2m'];
    room.players[0].hand = ['1m', ...losing];
    room.discard(room.players[0], '1m');
    expect(room.result.text).toContain('回文あがり');
  });
  it('一つ跳びの順子を認める独自のあがり形を書ける', () => {
    const room = roomWith(`on('win_check', (g, e) => {
      if (e.allowed) return true;
      const counts = {}; for (const t of e.hand) counts[t] = (counts[t] || 0) + 1;
      const solve = (left) => {
        const t = sortTiles(Object.keys(left).filter(k => left[k] > 0))[0];
        if (!t) return true;
        if (left[t] >= 3) { left[t] -= 3; const ok = solve(left); left[t] += 3; if (ok) return true; }
        if (!isHonor(t)) for (const step of [1, 2]) {
          const b = (rank(t) + step) + suit(t), c = (rank(t) + step * 2) + suit(t);
          if (left[b] > 0 && left[c] > 0) { left[t]--; left[b]--; left[c]--; const ok = solve(left); left[t]++; left[b]++; left[c]++; if (ok) return true; }
        }
        return false;
      };
      return Object.keys(counts).some(t => { if (counts[t] < 2) return false; counts[t] -= 2; const ok = solve(counts); counts[t] += 2; return ok; });
    });`);
    room.players[0].hand = split('2m 4m 6m 1p 3p 5p 3s 5s 7s 1z 1z 1z 9p 9p');
    expect(room.isWinning(0, room.players[0].hand)).toBe(true);
    room.players[0].hand = split('2m 4m 7m 1p 3p 5p 3s 5s 7s 1z 1z 1z 9p 9p');
    expect(room.isWinning(0, room.players[0].hand)).toBe(false);
  });
  it('白ジョーカーを含む判定ヘルパーを使える', () => {
    const room = roomWith(`on('win_check', (g, e) => e.allowed || isWinningHand(e.hand, {melds: g.players[e.actor].melds, joker: '5z'}));`);
    room.players[0].hand = split('1m 2m 3m 4m 5m 6m 7p 8p 9p 1s 2s 5z 2z 2z');
    room.drawn = true;
    expect(room.snapshot(room.players[0]).can_tsumo).toBe(true);
  });
});

describe('生成ルールの登録', () => {
  it('置換・撤回・初期化でき、件数・文字数の上限を超えた追加は原状を維持する', () => {
    const base = `on('speech', (g, e) => g.award(e.actor, 100));`;
    let programs = updatePrograms([], verdict(base, 'a'));
    programs = updatePrograms(programs, verdict(`on('speech', (g, e) => g.award(e.actor, 200));`, 'a', 'replace'));
    expect(programs).toHaveLength(1);
    expect(programs[0].code).toContain('200');
    expect(updatePrograms(programs, {...verdict('', 'a', 'remove'), program: {mode: 'remove', id: 'a', code: ''}})).toEqual([]);
    expect(updatePrograms(programs, {...verdict('', '', 'clear'), program: {mode: 'clear', id: '', code: ''}})).toEqual([]);
    expect(() => updatePrograms(programs, verdict(base, 'a'))).toThrow('同じID');
    let full = [];
    for (let i = 0; i < LIMITS.programs; i++) full = updatePrograms(full, verdict(base, `p${i}`));
    expect(() => updatePrograms(full, verdict(base, 'extra'))).toThrow('保存上限');
    expect(() => validateVerdict(verdict(`on('speech', () => {}); //${'x'.repeat(LIMITS.chars)}`))).toThrow();
  });
  it('構文エラー・未登録・未対応イベントのコードを採用しない', () => {
    for (const code of ['on("draw", (g) => {', 'const x = 1;', 'on("before_win", () => {})', '[{"on":"draw","when":true,"do":[["award",100]]}]']) {
      expect(() => validateVerdict(verdict(code))).toThrow('生成コードを実行できません');
    }
  });
});

describe('レビュー指摘の回帰', () => {
  it('副露の種類・放銃元だけの変更も反映する', () => {
    const room = roomWith(`on('speech', (g) => { g.players[0].melds[0].from = 2; g.players[0].melds[0].type = 'kan'; });`);
    room.players[0].melds = [{type: 'pon', tiles: ['5z', '5z', '5z'], from: 1}];
    room.speech(room.players[0], '変更');
    expect(room.players[0].melds[0]).toMatchObject({type: 'kan', from: 2});
  });
  it('ツモ可否の表示・NPC判定・実際のツモで同じあがり牌を渡す', () => {
    const room = roomWith(`on('win_check', (g, e) => e.tile === '7z' || undefined);`);
    room.players[0].hand = [...losing, '7z'];
    expect(room.snapshot(room.players[0]).can_tsumo).toBe(true);
    room.players[0].npc = true; room.npc_deadline = 0;
    room.tick();
    expect(room.result?.winner).toBe(0);
  });
  it('打牌前フックが打牌する牌を動かしたら打牌を取り消し、他の牌を失わない', () => {
    const room = roomWith(`on('before_discard', (g, e) => { const h = g.players[e.actor].hand; g.wall.push(h.splice(h.indexOf(e.tile), 1)[0]); });`);
    room.players[0].hand = [...losing, '7z'];
    room.discard(room.players[0], '7z');
    expect(room.players[0].hand).toEqual(losing);
    expect(room.players[0].river).toEqual([]);
    expect(room.turn).toBe(0);
    expect(room.claim).toBe(null);
    expect(room.wall[0]).toBe('7z');
  });
  it('鳴き前フックが牌を動かしたら鳴きを取り消し、河の別の牌を消さない', () => {
    const room = roomWith(`on('before_call', (g, e) => { g.players[e.actor].hand.pop(); });`);
    for (const p of room.players) { p.hand = [...losing]; p.river = []; }
    room.players[1].hand = ['5z', '5z', ...losing.slice(2)];
    room.players[0].river = ['1m', '5z']; room.claim = {tile: '5z', from: 0, passed: [], requests: [], deadline: Date.now() / 1000 + 8};
    room.call(room.players[1], 'pon', ['5z', '5z']);
    expect(room.players[1].melds).toEqual([]);
    expect(room.players[0].river).toEqual(['1m', '5z']);
    expect(room.claim).toBe(null);
    expect(room.turn).toBe(1);
  });
});

describe('レビュー指摘の回帰（2回目）', () => {
  it('同じコード内の複数ハンドラーは前の戻り値を受け取る', () => {
    const room = roomWith(`on('win_score', () => 1000); on('win_score', (g, e) => e.points * 2);
      on('win_check', () => false); on('win_check', (g, e) => e.allowed || e.hand.length === 14);`);
    room.finish(0, 1, ['1z'], 'ロン');
    expect(room.result.deltas[0]).toBe(2000);
    room.status = 'playing';
    expect(room.isWinning(0, [...losing, '7z'])).toBe(true);
  });
  it('ツモ前フックの即あがりで流局や追加ツモに進まない', () => {
    for (const wall of [0, 10]) {
      const room = roomWith(`on('before_draw', (g, e) => g.win(e.actor, '先取り'));`);
      room.wall = room.wall.slice(0, wall);
      const count = room.players[1].hand.length;
      room.advance();
      expect(room.result.text).toContain('先取り');
      expect(room.result.winner).toBe(1);
      expect(room.players[1].hand).toHaveLength(count);
      expect(room.wall).toHaveLength(wall);
    }
  });
  it('開局・配牌中の即あがりは無視して通常どおり配る', () => {
    const room = roomWith(`on('before_round_start', (g, e) => g.win(e.actor)); on('after_deal', (g, e) => g.win(e.actor));`);
    room.status = 'finished'; room.start(room.players[0]);
    expect(room.status).toBe('playing');
    expect(room.players.map(p => p.hand.length)).toEqual([13, 14, 13, 13]);
  });
});

describe('レビュー指摘の回帰（3回目）', () => {
  it('発言前フックの即あがりで合言葉あがりを重ねない', () => {
    const room = roomWith(`on('before_speech', (g, e) => g.win(e.actor, '先取り'));`);
    room.rules.speech_keyword = '白'; room.rules.speech_effect = 'win';
    room.speech(room.players[0], '白');
    expect(room.result.text).toContain('先取り');
    expect(room.players.map(p => p.score)).toEqual([31000, 23000, 23000, 23000]);
  });
  it('空きのある支払い配列は取り消して通常の支払いにする', () => {
    const room = roomWith(`on('payment', (g, e) => { const d = new Array(4); d[e.winner] = 9000; d[e.loser] = -9000; return d; });`);
    room.finish(0, 1, ['1z'], 'ロン');
    expect(room.result.deltas).toEqual([6000, -6000, 0, 0]);
    expect(room.players.every(p => Number.isFinite(p.score))).toBe(true);
    expect(room.programs[0].disabled).toBe(true);
  });
});
