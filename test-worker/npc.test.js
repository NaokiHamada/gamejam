import {describe, it, expect} from 'vitest';
import {Room, DEFAULT_RULES, now} from '../worker/game.js';
import {chooseDiscard} from '../worker/npc.js';

const tiles = text => text.split(' ');
function solo() {
  const room = new Room('ABCDE'), host = room.join('人間');
  for (let i = 0; i < 3; i++) room.action('add_npc', host, {});
  room.action('ready', host, {}); room.start(host);
  return room;
}
const winning = tiles('1m 2m 3m 4m 5m 6m 2p 3p 4p 7s 8s 9s 1z 1z');
const losing = tiles('1m 3m 5m 7m 9m 1p 3p 5p 7p 9p 1s 3s 5s');

describe('NPC', () => {
  it('部屋主だけが開局前に追加・削除でき、トークンと手牌を公開しない', () => {
    const room = new Room('ABCDE'), host = room.join('主'), guest = room.join('客');
    expect(() => room.action('add_npc', guest, {})).toThrow();
    room.action('add_npc', host, {});
    expect(room.players[2].ready).toBe(true);
    expect(room.player(room.players[2].token)).toBeUndefined();
    expect(() => room.action('remove_npc', guest, {seat: 2})).toThrow();
    expect(() => room.action('remove_npc', host, {seat: 1})).toThrow();
    const view = room.snapshot(host, new Set());
    expect(view.players[2]).toMatchObject({npc: true, online: true});
    expect(view.players.every(p => !('token' in p) && !('hand' in p))).toBe(true);
    room.action('remove_npc', host, {seat: 2});
    room.action('add_npc', host, {}); room.action('add_npc', host, {});
    expect(() => room.action('add_npc', host, {})).toThrow();
    host.ready = guest.ready = true; room.start(host);
    expect(() => room.action('remove_npc', host, {seat: 2})).toThrow();
    expect(() => room.action('add_npc', host, {})).toThrow();
  });
  it('孤立した字牌を切り、順子・対子・ジョーカーを残す', () => {
    expect(chooseDiscard(tiles('1m 2m 3m 4m 5m 6m 2p 3p 4p 7s 8s 1z 1z 7z'), DEFAULT_RULES)).toBe('7z');
    expect(chooseDiscard(tiles('1m 2m 3m 4m 5m 6m 2p 3p 4p 7s 8s 1z 5z 7z'), {...DEFAULT_RULES, joker: '7z'})).not.toBe('7z');
    expect(chooseDiscard(tiles('2m 3m 4m 5m 6m 7m 2p 3p 4p 5p 6p 7p 8s 1z'), {...DEFAULT_RULES, win_condition: 'all_simples'})).toBe('1z');
  });
  it('NPCの打牌が待ち時間後に進み、逆回りとAI停止を守る', () => {
    const room = solo(); room.turn = 1;
    room.players[1].hand = [...losing, '7z'];
    room.players[0].hand = room.players[2].hand = room.players[3].hand = [...losing];
    room.rules.reverse_order = true;
    expect(room.tick()).toBe(false);
    room.npc_deadline = 0; room.pending = true;
    expect(room.tick()).toBe(false); expect(room.npcDeadline()).toBe(Infinity);
    room.pending = false;
    expect(room.tick()).toBe(true); expect(room.turn).toBe(0);
    expect(room.players[1].river).toHaveLength(1); expect(room.ai_calls).toBe(0);
    expect(room.tick()).toBe(false);
  });
  it('変更された固定条件でツモし、次局へNPCと持ち点を引き継ぐ', () => {
    const room = solo(); room.turn = 1; room.npc_deadline = 0;
    room.rules.win_condition = 'any_pair';
    room.players[1].hand = [...losing, '1m'];
    room.tick(); expect(room.result.winner).toBe(1);
    const score = room.players[1].score;
    room.start(room.players[0]); expect(room.round).toBe(2);
    expect(room.players[1]).toMatchObject({npc: true, ready: true, score});
  });
  it('生成コードの条件でもツモできる', () => {
    const room = solo(); room.turn = 1; room.npc_deadline = 0;
    room.players[1].hand = [...losing, '7z'];
    room.programs = [{id: 'any', title: '条件', code: JSON.stringify([{on: 'win_check', when: true, do: [['win']]}]), memory: [{}, {}, {}, {}]}];
    room.tick(); expect(room.result.winner).toBe(1);
  });
  it('人間のロン機会を表示したうえでNPCもロンし、見送り済みは対象外', () => {
    const room = solo();
    room.players[1].hand = winning.slice(0, -1);
    room.claim = {tile: '1z', from: 0, passed: [2], deadline: now() + 8};
    room.npc_deadline = now() + 1.2;
    expect(room.tick()).toBe(false);
    room.npc_deadline = 0; room.tick();
    expect(room.result.winner).toBe(1); expect(room.result.deltas).toEqual([-6000, 6000, 0, 0]);
    expect(room.players.reduce((sum, p) => sum + p.score, 0)).toBe(100000);
  });
  it('部屋主の退席では人間へ権限を移し、最後の人間が退席するとNPCも除く', () => {
    const room = new Room('ABCDE'), host = room.join('主');
    room.action('add_npc', host, {}); const guest = room.join('客');
    room.action('leave', host, {}); expect(room.players[0]).toBe(guest);
    room.action('leave', guest, {}); expect(room.players).toEqual([]);
  });
  it('1人とNPC3人で打牌から局終了まで進行する', () => {
    const room = solo();
    for (let i = 0; i < 160 && room.status === 'playing'; i++) {
      if (room.claim) { room.claim.deadline = 0; room.tick(); }
      else if (room.players[room.turn].npc) { room.npc_deadline = 0; room.tick(); }
      else { room.discard(room.players[0], room.players[0].hand.at(-1)); }
    }
    expect(room.status).toBe('finished');
    expect(room.players.reduce((sum, p) => sum + p.score, 0)).toBe(100000);
  });
});
