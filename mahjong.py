"""Server-authoritative, deliberately small mahjong variant. No third party dependencies."""
from collections import Counter
from functools import lru_cache
import copy
import random
import secrets
import time

TILES = [f'{n}{s}' for s in 'mps' for n in range(1, 10)] + [f'{n}z' for n in range(1, 8)]
DEFAULT_RULES = dict(win_condition='standard', seven_pairs=True, joker='none', win_points=6000,
                     bonus_suit='none', bonus_points=500, reverse_order=False,
                     turn_seconds=45, speech_keyword='', speech_effect='bonus', speech_points=300)
WIN_NAMES = dict(standard='4面子＋1雀頭', any_pair='対子が1組あればOK',
                 two_pairs='対子が2組あればOK', any_triplet='刻子が1組あればOK',
                 all_simples='手牌がすべて2〜8の数牌')

class GameError(Exception):
    pass

def require(ok, message):
    if not ok:
        raise GameError(message)

def sorted_hand(hand):
    return sorted(hand, key=TILES.index)

@lru_cache(maxsize=32768)
def meldable(counts, wild):
    if not any(counts):
        return wild % 3 == 0
    i = next(i for i, n in enumerate(counts) if n)
    # Every group containing the lowest real tile is a triplet or a sequence.
    take = min(3, counts[i])
    if wild >= 3 - take:
        c = list(counts)
        c[i] -= take
        if meldable(tuple(c), wild - (3 - take)):
            return True
    if i < 27:
        base = i // 9 * 9
        for start in range(max(base, i - 2), min(i, base + 6) + 1):
            c = list(counts)
            missing = 0
            for j in range(start, start + 3):
                if c[j]:
                    c[j] -= 1
                else:
                    missing += 1
            if missing <= wild and meldable(tuple(c), wild - missing):
                return True
    return False

def winning(hand, rules):
    if len(hand) != 14:
        return False
    counter = Counter(hand)
    wild = counter.pop(rules['joker'], 0)
    counts = tuple(counter.get(t, 0) for t in TILES)
    pairs = sum(n // 2 for n in counts)
    if rules['win_condition'] == 'any_pair':
        return pairs > 0 or wild >= 2 or (wild > 0 and bool(counter))
    if rules['win_condition'] == 'two_pairs':
        singles = sum(n % 2 for n in counts)
        used = min(wild, singles)
        return pairs + used + (wild - used) // 2 >= 2
    if rules['win_condition'] == 'any_triplet':
        return max(counts, default=0) + wild >= 3
    if rules['win_condition'] == 'all_simples':
        return all(t[1] != 'z' and t[0] not in '19' for t in counter)
    # Seven distinct pairs; four of the same tile does not count as two pairs.
    if rules['seven_pairs']:
        distinct = sum(n > 0 for n in counts)
        odd = sum(n % 2 for n in counts)
        if max(counts, default=0) <= 2 and odd <= wild and distinct + (wild - odd) // 2 == 7:
            return True
    for i, n in enumerate(counts):
        if n:
            take = min(2, n)
            if wild >= 2 - take:
                c = list(counts)
                c[i] -= take
                if meldable(tuple(c), wild - (2 - take)):
                    return True
    return wild >= 2 and meldable(counts, wild - 2)

def validate_rules(rules):
    require(isinstance(rules, dict) and set(rules) == set(DEFAULT_RULES), 'ルールの形式が不正です。')
    enums = dict(win_condition=list(WIN_NAMES), joker=['none'] + TILES,
                 bonus_suit=['none', 'm', 'p', 's', 'z'], speech_effect=['bonus', 'win'])
    for key, choices in enums.items():
        require(rules[key] in choices, '未対応のルールです。')
    for key, lo, hi in [('win_points',1000,24000),('bonus_points',100,2000),
                        ('turn_seconds',15,120),('speech_points',100,3000)]:
        require(type(rules[key]) is int and lo <= rules[key] <= hi, 'ルールの数値が範囲外です。')
    for key in ['seven_pairs', 'reverse_order']:
        require(type(rules[key]) is bool, 'ルールの値が不正です。')
    require(isinstance(rules['speech_keyword'], str) and len(rules['speech_keyword']) <= 20,
            '合言葉は20文字以内です。')

class Room:
    def __init__(self, code):
        self.code = code
        self.players = []
        self.status = 'lobby'
        self.rules = copy.deepcopy(DEFAULT_RULES)
        self.history = []
        self.messages = []
        self.pending = False
        self.ai_calls = 0
        self.round = 0
        self.version = 0
        self.wall = []
        self.turn = 0
        self.claim = None
        self.deadline = 0
        self.result = None
        self.created = self.touched = time.time()

    def event(self, kind, text, **extra):
        self.version += 1
        self.touched = time.time()
        item = dict(id=self.version, kind=kind, text=text, time=time.time(), **extra)
        self.messages.append(item)
        self.messages = self.messages[-120:]
        return item

    def join(self, name):
        require(self.status == 'lobby', 'この部屋は対局中です。')
        require(len(self.players) < 4, 'この部屋は満席です。')
        require(isinstance(name, str) and 1 <= len(name.strip()) <= 12, '名前を1〜12文字で入力してください。')
        p = dict(token=secrets.token_urlsafe(32), name=name.strip(), score=25000,
                 hand=[], river=[], ready=False, seen=time.time(), last_speech=0)
        self.players.append(p)
        self.event('system', f'{p["name"]} が着席しました。')
        return p

    def player(self, token):
        return next((p for p in self.players if secrets.compare_digest(p['token'], token)), None)

    def start(self, p):
        require(p is self.players[0], '部屋主だけが開始できます。')
        require(self.status in ('lobby', 'finished'), 'すでに対局中です。')
        require(not self.pending, 'AIの判定を待ってください。')
        require(len(self.players) == 4, '4人そろうと開始できます。')
        require(all(q['ready'] for q in self.players), '全員の準備完了を待ってください。')
        self.round += 1
        self.status = 'playing'
        self.result = self.claim = None
        self.wall = TILES * 4
        random.SystemRandom().shuffle(self.wall)
        for q in self.players:
            q['hand'] = sorted_hand([self.wall.pop() for _ in range(13)])
            q['river'] = []
        self.turn = (self.round - 1) % 4
        self.draw()
        self.event('system', f'第{self.round}局、開局。言ったもん勝ち、はじめましょう。')

    def draw(self):
        if not self.wall:
            self.status = 'finished'
            self.result = dict(winner=None, text='流局。山牌がなくなりました。', deltas=[0]*4, hand=[])
            self.event('result', self.result['text'])
            return
        self.players[self.turn]['hand'].append(self.wall.pop())
        self.deadline = time.time() + self.rules['turn_seconds']

    def can_ron(self, index):
        return bool(self.claim and index != self.claim['from'] and
                    index not in self.claim['passed'] and
                    winning(self.players[index]['hand'] + [self.claim['tile']], self.rules))

    def discard(self, p, tile):
        require(self.status == 'playing' and not self.pending, 'いまは打牌できません。')
        require(self.claim is None and p is self.players[self.turn], 'あなたの打牌順ではありません。')
        require(tile in p['hand'], 'その牌は手牌にありません。')
        p['hand'].remove(tile)
        p['hand'] = sorted_hand(p['hand'])
        p['river'].append(tile)
        self.claim = dict(tile=tile, **{'from': self.turn}, passed=[], deadline=time.time()+8)
        self.event('discard', f'{p["name"]} が打牌。', tile=tile, seat=self.turn)
        if not any(self.can_ron(i) for i in range(4)):
            self.advance()

    def advance(self):
        self.claim = None
        self.turn = (self.turn + (-1 if self.rules['reverse_order'] else 1)) % 4
        self.draw()

    def win(self, p, method):
        require(self.status == 'playing' and not self.pending, 'いまはあがれません。')
        i = self.players.index(p)
        if method == 'ron':
            require(self.can_ron(i), 'ロンできる手牌ではありません。')
            self.finish(i, self.claim['from'], p['hand']+[self.claim['tile']], 'ロン')
        else:
            require(not self.claim and i == self.turn and winning(p['hand'], self.rules), 'ツモあがりできる手牌ではありません。')
            self.finish(i, None, p['hand'], 'ツモ')

    def finish(self, winner, loser, hand, label):
        points = self.rules['win_points'] + sum(t[1] == self.rules['bonus_suit'] for t in hand) * self.rules['bonus_points']
        points = min(60000, points)
        deltas = [0]*4
        if loser is None:
            share = ((points + 299)//300)*100
            for i in range(4):
                deltas[i] = 3*share if i == winner else -share
        else:
            deltas[winner], deltas[loser] = points, -points
        for i, p in enumerate(self.players):
            p['score'] += deltas[i]
        self.status = 'finished'
        self.claim = None
        self.result = dict(winner=winner, text=f'{self.players[winner]["name"]} の{label}！ +{deltas[winner]:,}点',
                           deltas=deltas, hand=sorted_hand(hand))
        self.event('result', self.result['text'])

    def tick(self):
        if self.status != 'playing' or self.pending:
            return
        if self.claim and time.time() >= self.claim['deadline']:
            self.advance()
        elif not self.claim and time.time() >= self.deadline:
            p = self.players[self.turn]
            self.event('system', f'{p["name"]} は時間切れでツモ切り。')
            self.discard(p, p['hand'][-1])

    def snapshot(self, p):
        i = self.players.index(p)
        active = self.status == 'playing' and not self.pending
        return dict(code=self.code, me=i, host=i == 0, status=self.status, version=self.version,
                    round=self.round, wall=len(self.wall), turn=self.turn, rules=self.rules,
                    players=[dict(name=q['name'], score=q['score'], ready=q['ready'],
                                  online=time.time()-q['seen'] < 15, count=len(q['hand']), river=q['river']) for q in self.players],
                    hand=list(p['hand']), messages=self.messages, history=self.history[-30:],
                    pending=self.pending, ai_calls=self.ai_calls, result=self.result,
                    claim={k:v for k,v in self.claim.items() if k != 'passed'} if self.claim else None,
                    deadline=self.claim['deadline'] if self.claim else self.deadline,
                    server_time=time.time(), can_discard=active and not self.claim and i == self.turn,
                    can_tsumo=active and not self.claim and i == self.turn and winning(p['hand'], self.rules),
                    can_ron=active and self.can_ron(i))
