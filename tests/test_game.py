import copy
import json
import threading
import time
import unittest
import urllib.request
import urllib.error
from mahjong import DEFAULT_RULES, GameError, Room, TILES, winning, validate_rules
from server import App, make_server

class FakeReferee:
    key = 'test-only'
    model = 'fake'
    def __init__(self, fail=False):
        self.fail = fail
    def judge(self, text, rules):
        time.sleep(.05)
        if self.fail:
            raise GameError('テスト用のAPIエラー')
        rules['win_condition'] = 'any_pair'
        rules['reverse_order'] = True
        return dict(accepted=True, title='対子で逆回り', explanation='対子1組であがり、逆回り。', rules=rules)

class EngineTests(unittest.TestCase):
    def setUp(self):
        self.room=Room('TEST1')
        self.players=[self.room.join('player'+str(i)) for i in range(4)]
        for p in self.players:
            p['ready']=True
        self.room.start(self.players[0])

    def test_deal_and_privacy(self):
        self.assertEqual([len(p['hand']) for p in self.players],[14,13,13,13])
        self.assertEqual(len(self.room.wall),83)
        self.assertCountEqual(self.room.wall+sum([p['hand'] for p in self.players],[]),TILES*4)
        snap=self.room.snapshot(self.players[1])
        self.assertEqual(snap['hand'],self.players[1]['hand'])
        self.assertFalse(any('hand' in p or 'token' in p for p in snap['players']))
        self.assertNotIn('wall_tiles',snap)

    def test_turn_enforcement_and_timeout(self):
        with self.assertRaises(GameError):
            self.room.discard(self.players[1],self.players[1]['hand'][0])
        self.room.deadline=0
        self.room.tick()
        self.assertEqual(len(self.players[0]['river']),1)
        self.assertEqual(len(self.players[0]['hand']),13)

    def test_regular_and_seven_pairs(self):
        hand='1m 2m 3m 4m 5m 6m 2p 3p 4p 7s 8s 9s 1z 1z'.split()
        self.assertTrue(winning(hand,DEFAULT_RULES))
        self.assertFalse(winning(hand[:-1]+['2z'],DEFAULT_RULES))
        pairs='1m 1m 3m 3m 5p 5p 7p 7p 4s 4s 2z 2z 3z 3z'.split()
        self.assertTrue(winning(pairs,DEFAULT_RULES))
        self.assertFalse(winning(pairs,dict(DEFAULT_RULES,seven_pairs=False)))
        four='1m 1m 1m 1m 5p 5p 7p 7p 4s 4s 2z 2z 3z 3z'.split()
        self.assertFalse(winning(four,DEFAULT_RULES))

    def test_joker_handles_sequence_before_first_real_tile(self):
        hand='5z 2m 3m 4m 5m 6m 2p 3p 4p 7s 8s 9s 1z 1z'.split()
        self.assertFalse(winning(hand,DEFAULT_RULES))
        self.assertTrue(winning(hand,dict(DEFAULT_RULES,joker='5z')))
        hand='5z 5z 3m 4m 5m 6m 2p 3p 4p 7s 8s 9s 1z 1z'.split()
        self.assertTrue(winning(hand,dict(DEFAULT_RULES,joker='5z')))

    def test_rule_changes_affect_real_win_and_zero_sum_score(self):
        hand='1m 1m 3m 5m 7m 9m 2p 4p 6p 8p 1s 3s 5s 7s'.split()
        self.players[0]['hand']=hand
        with self.assertRaises(GameError):
            self.room.win(self.players[0],'tsumo')
        self.room.rules['win_condition']='any_pair'
        self.room.win(self.players[0],'tsumo')
        self.assertEqual(self.room.status,'finished')
        self.assertEqual([p['score'] for p in self.players],[31000,23000,23000,23000])
        self.assertEqual(sum(self.room.result['deltas']),0)

    def test_ron_pass_reverse(self):
        self.room.rules['win_condition']='any_pair'
        self.room.rules['reverse_order']=True
        self.players[1]['hand']='1m 1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 2p 3p'.split()
        self.room.discard(self.players[0],self.players[0]['hand'][-1])
        self.assertTrue(self.room.can_ron(1))
        self.room.win(self.players[1],'ron')
        self.assertEqual(self.room.result['deltas'],[-6000,6000,0,0])
        self.room.start(self.players[0])
        self.room.discard(self.players[1],self.players[1]['hand'][-1])
        if self.room.claim:
            self.room.claim['deadline']=0
            self.room.tick()
        self.assertEqual(self.room.turn,0)

    def test_exhaustive_draw(self):
        self.room.wall=[]
        self.room.draw()
        self.assertEqual(self.room.status,'finished')
        self.assertIsNone(self.room.result['winner'])

    def test_rule_validation(self):
        for bad in [dict(DEFAULT_RULES,win_points=999999),dict(DEFAULT_RULES,joker='../../apikey.local'),dict(DEFAULT_RULES,turn_seconds=True)]:
            with self.assertRaises(GameError): validate_rules(bad)

class NetworkTests(unittest.TestCase):
    def setUp(self):
        self.app=App(FakeReferee())
        self.server=make_server('127.0.0.1',0,self.app)
        threading.Thread(target=self.server.serve_forever,daemon=True).start()
        self.url='http://127.0.0.1:'+str(self.server.server_address[1])
        self.clients=[]
        for i in range(4):
            result=self.post(dict(action='create' if i==0 else 'join',name='人'+str(i),code=getattr(self,'code','')))
            self.code=result['state']['code']
            self.clients.append(result['token'])
        for token in self.clients:
            self.act('ready',token)
        self.act('start',self.clients[0])

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def post(self,body,token='',origin=None):
        headers={'Content-Type':'application/json','Authorization':'Bearer '+token}
        if origin: headers['Origin']=origin
        req=urllib.request.Request(self.url+'/api/action',data=json.dumps(body).encode(),headers=headers)
        with urllib.request.urlopen(req) as response: return json.load(response)

    def act(self,action,token=None,**kw):
        return self.post(dict(action=action,code=self.code,**kw),token or self.clients[0])

    def get(self,token=None):
        req=urllib.request.Request(self.url+'/api/state/'+self.code,headers={'Authorization':'Bearer '+(token or self.clients[0])})
        with urllib.request.urlopen(req) as response: return json.load(response)['state']

    def wait_for_ai(self):
        deadline=time.time()+3
        while time.time()<deadline:
            s=self.get()
            if not s['pending']:return s
            time.sleep(.01)
        self.fail('AI thread did not finish')

    def test_four_clients_rule_sync_and_reconnect(self):
        first=self.get()
        changed=self.act('speech',text='対子であがり、逆回りにしよう')['state']
        self.assertTrue(changed['pending'])
        with self.assertRaises(urllib.error.HTTPError) as err:self.act('discard',tile=first['hand'][-1])
        err.exception.close()
        final=self.wait_for_ai()
        self.assertEqual(final['rules']['win_condition'],'any_pair')
        self.assertTrue(final['rules']['reverse_order'])
        self.assertGreater(final['deadline'],first['deadline'])
        for token in self.clients:
            snapshot=self.get(token)
            self.assertEqual(snapshot['rules'],final['rules'])
            self.assertEqual(snapshot['history'],final['history'])
        self.assertEqual(self.get(self.clients[2])['hand'],self.get(self.clients[2])['hand'])

    def test_ai_error_restores_play_and_rules(self):
        self.app.referee=FakeReferee(fail=True)
        self.act('speech',text='対子で勝ちたい')
        final=self.wait_for_ai()
        self.assertEqual(final['rules'],DEFAULT_RULES)
        self.assertEqual(final['messages'][-1]['kind'],'error')
        self.assertTrue(final['can_discard'])
        self.assertTrue(self.app.ai_slots.acquire(blocking=False))
        self.app.ai_slots.release()

    def test_ai_capacity_rejection_has_no_side_effects(self):
        room=self.app.rooms[self.code]
        room.rules.update(speech_keyword='ポテト',speech_effect='bonus')
        self.assertTrue(self.app.ai_slots.acquire(blocking=False))
        self.assertTrue(self.app.ai_slots.acquire(blocking=False))
        before=len(room.messages)
        try:
            with self.assertRaises(urllib.error.HTTPError) as err:
                self.act('speech',text='ポテト')
            err.exception.close()
            self.assertEqual([p['score'] for p in room.players],[25000]*4)
            self.assertEqual(len(room.messages),before)
            self.assertFalse(room.pending)
        finally:
            self.app.ai_slots.release()
            self.app.ai_slots.release()

    def test_speech_effect_and_win(self):
        room=self.app.rooms[self.code]
        room.rules.update(speech_keyword='ポテト',speech_effect='bonus')
        self.act('speech',text='ポテト')
        self.wait_for_ai()
        self.assertEqual([p['score'] for p in room.players],[25900,24700,24700,24700])
        room.rules.update(speech_effect='win')
        room.players[1]['last_speech']=0
        self.act('speech',self.clients[1],text='ポテト')
        self.assertEqual(room.status,'finished')
        self.assertEqual(room.result['winner'],1)
        self.assertEqual(sum(p['score'] for p in room.players),100000)

    def test_auth_fifth_player_and_secret_paths(self):
        with self.assertRaises(urllib.error.HTTPError) as err:self.get('invalid')
        err.exception.close()
        with self.assertRaises(urllib.error.HTTPError) as err:self.post(dict(action='join',code=self.code,name='5人目'))
        err.exception.close()
        for path in ['/apikey.local','/ai_referee.py','/../apikey.local','/.env']:
            with self.assertRaises(urllib.error.HTTPError) as e:urllib.request.urlopen(self.url+path)
            self.assertEqual(e.exception.code,404)
            e.exception.close()
        with self.assertRaises(urllib.error.HTTPError) as err:self.post(dict(action='ready',code=self.code),self.clients[0],origin='https://evil.example')
        err.exception.close()

if __name__=='__main__':unittest.main()
