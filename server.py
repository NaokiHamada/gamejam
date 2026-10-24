#!/usr/bin/env python3
"""LAN-only prototype server. Run: python3 server.py"""
import argparse
import copy
import errno
from http.client import HTTPConnection, HTTPException
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import socket
import sys
import threading
import time
from urllib.parse import urlparse

from ai_referee import Referee
from mahjong import Room, GameError, require, DEFAULT_RULES

ROOT = Path(__file__).parent

# A mobile browser may close a speculative connection before sending HTTP.
# Keep these transport failures separate from application/programming errors.
CONNECTION_ERRNOS = {errno.EBADF, errno.EPIPE, errno.ECONNRESET,
                     errno.ECONNABORTED, errno.ENOTCONN, errno.ETIMEDOUT,
                     errno.EACCES, errno.EPERM}


def lan_address():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            # Route lookup only; no packet or private data is sent.
            sock.connect(('192.0.2.1', 80))
            return sock.getsockname()[0]
    except OSError:
        return None


def probe_http(host, port):
    """Check a real HTTP round trip directly, without using a system proxy."""
    connection = HTTPConnection(host, port, timeout=3)
    try:
        connection.request('GET', '/api/health')
        response = connection.getresponse()
        body = response.read(4096)
        ok = response.status == 200 and json.loads(body).get('ok') is True
        return dict(ok=ok, errno=None)
    except OSError as error:
        return dict(ok=False, errno=error.errno)
    except (ValueError, AttributeError, HTTPException):
        # HTTP protocol errors carry no reliable errno. Do not expose bodies.
        return dict(ok=False, errno=None)
    finally:
        connection.close()


def check_network(server, address):
    port = server.server_address[1]
    local = probe_http('127.0.0.1', port)
    lan = probe_http(address, port) if address else None
    result = dict(localhost=local, lan=lan, address=address)
    server.network_check = result
    print(f'  接続診断: localhost {"OK" if local["ok"] else "NG"} / LAN '
          f'{"OK" if lan and lan["ok"] else "NG" if lan else "未検出"}', flush=True)
    if local['ok'] and lan and not lan['ok']:
        print('  LAN受信に失敗しています。起動元アプリのローカルネットワーク許可と、\n'
              '  CiscoなどのネットワークフィルターのLAN受信許可を確認してください。\n'
              '  localhostがOKでも、スマホから接続できる状態とは限りません。', flush=True)
    return result


class GameHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, *args, **kwargs):
        self.network_check = None
        self._reported_transport_errors = set()
        self._transport_error_lock = threading.Lock()
        super().__init__(*args, **kwargs)

    def report_transport_error(self, error):
        if error.errno not in (errno.EBADF, errno.EACCES, errno.EPERM):
            return
        with self._transport_error_lock:
            if error.errno in self._reported_transport_errors:
                return
            self._reported_transport_errors.add(error.errno)
        print(f'  接続の受信に失敗しました (errno={error.errno})。\n'
              '  ネットワークのアクセス許可／ソケットフィルターを確認してください。\n'
              '  この接続は終了します。他の接続と対局は維持します。', file=sys.stderr, flush=True)

class App:
    def __init__(self, referee=None):
        self.rooms = {}
        self.lock = threading.RLock()
        self.referee = referee or Referee()
        self.ai_slots = threading.BoundedSemaphore(2)

    def auth(self, code, token):
        room = self.rooms.get(code)
        require(room is not None, '部屋が見つかりません。コードを確認してください。')
        p = room.player(token)
        require(p is not None, '参加情報が無効です。部屋に入り直してください。')
        p['seen'] = time.time()
        room.touched = time.time()
        return room, p

    def cleanup(self):
        now = time.time()
        for code in list(self.rooms):
            if now - self.rooms[code].touched > 6*3600:
                del self.rooms[code]

    def action(self, body, token):
        with self.lock:
            action = body.get('action')
            if action == 'create':
                self.cleanup()
                require(len(self.rooms) < 30, '部屋数の上限です。')
                code = ''.join(secrets.choice('ABCDEFGHJKLMNPQRSTUVWXYZ23456789') for _ in range(5))
                while code in self.rooms:
                    code = ''.join(secrets.choice('ABCDEFGHJKLMNPQRSTUVWXYZ23456789') for _ in range(5))
                room = Room(code)
                p = room.join(body.get('name'))
                self.rooms[code] = room
                return dict(token=p['token'], state=room.snapshot(p))
            code = body.get('code', '')
            require(isinstance(code, str), '部屋コードが不正です。')
            code = code.upper().strip()
            if action == 'join':
                require(code in self.rooms, '部屋が見つかりません。')
                room = self.rooms[code]
                p = room.join(body.get('name'))
                return dict(token=p['token'], state=room.snapshot(p))
            room, p = self.auth(code, token)
            room.tick()
            if action == 'ready':
                require(room.status == 'lobby', '準備を変更できません。')
                p['ready'] = not p['ready']
                room.event('system', f'{p["name"]}：' + ('準備完了！' if p['ready'] else '準備中'))
            elif action == 'start':
                room.start(p)
            elif action == 'discard':
                room.discard(p, body.get('tile'))
            elif action in ('tsumo', 'ron'):
                room.win(p, action)
            elif action == 'pass':
                require(room.status == 'playing' and room.claim and not room.pending, 'いまは見送りできません。')
                i = room.players.index(p)
                require(room.can_ron(i), '見送るロンがありません。')
                room.claim['passed'].append(i)
                if not any(room.can_ron(i) for i in range(4)):
                    room.advance()
            elif action == 'speech':
                text = body.get('text', '')
                require(isinstance(text, str) and 1 <= len(text.strip()) <= 280, '発言は1〜280文字で入力してください。')
                require(not room.pending, 'AI審判が考え中です。少し待ってください。')
                require(time.time()-p['last_speech'] >= 4, '発言は4秒あけてください。')
                if room.status == 'playing':
                    require(room.ai_calls < 80, 'この部屋のAI判定は80回までです。新しい部屋で続けられます。')
                    require(self.ai_slots.acquire(blocking=False), 'AI審判が混み合っています。少し待って再送してください。')
                p['last_speech'] = time.time()
                room.event('speech', text.strip(), seat=room.players.index(p), name=p['name'])
                if room.status == 'playing':
                    keyword = room.rules['speech_keyword']
                    if keyword and keyword in text:
                        i = room.players.index(p)
                        if room.rules['speech_effect'] == 'win':
                            room.finish(i, None, p['hand'], '合言葉あがり')
                            self.ai_slots.release()
                            return dict(state=room.snapshot(p))
                        points = room.rules['speech_points']
                        for j, q in enumerate(room.players):
                            q['score'] += points*3 if j == i else -points
                        room.event('system', f'合言葉「{keyword}」発動！ {p["name"]} が各員から{points:,}点ずつ獲得。')
                    room.pending = True
                    room.ai_calls += 1
                    threading.Thread(target=self.judge, args=(room,text.strip()), daemon=True).start()
            elif action == 'reset_rules':
                require(p is room.players[0] and room.status != 'playing' and not room.pending, '部屋主が局の合間にリセットできます。')
                room.rules = copy.deepcopy(DEFAULT_RULES)
                room.history.append(dict(title='初期ルールに戻しました', explanation='次の局から初期ルールで対戦します。', changes={}, by=p['name']))
                room.event('rule', '初期ルールに戻しました。')
            elif action == 'leave':
                require(room.status == 'lobby', '対局開始後は席を保持します。同じタブを開き直すと復帰できます。')
                room.players.remove(p)
                room.event('system', f'{p["name"]} が退席しました。')
                if not room.players:
                    del self.rooms[code]
                return dict(left=True)
            else:
                raise GameError('操作が見つかりません。')
            return dict(state=room.snapshot(p))

    def judge(self, room, text):
        started = time.time()
        try:
            with self.lock:
                before = copy.deepcopy(room.rules)
            result = self.referee.judge(text, copy.deepcopy(before))
            with self.lock:
                if result['accepted'] and result['rules'] != before:
                    changes = {key:dict(before=before[key], after=value) for key,value in result['rules'].items() if value != before[key]}
                    room.rules = result['rules']
                    room.history.append(dict(title=result['title'][:40], explanation=result['explanation'][:180], changes=changes,
                                             by=next((m.get('name','') for m in reversed(room.messages) if m['kind']=='speech'), '')))
                    room.event('rule', result['explanation'][:180], title=result['title'][:40], changes=changes)
                else:
                    room.event('judge', result['explanation'][:180])
        except Exception as e:
            with self.lock:
                # No exception details or response bodies are exposed, except our own safe errors.
                message = str(e) if isinstance(e, GameError) else 'AI判定に失敗しました。ルールは変更していません。'
                room.event('error', message)
        finally:
            with self.lock:
                elapsed = time.time()-started
                room.deadline += elapsed
                if room.claim:
                    room.claim['deadline'] += elapsed
                    if not any(room.can_ron(i) for i in range(4)):
                        room.advance()
                elif before['turn_seconds'] != room.rules['turn_seconds']:
                    room.deadline = time.time() + room.rules['turn_seconds']
                room.pending = False
            self.ai_slots.release()

class Handler(BaseHTTPRequestHandler):
    server_version = 'IttamonJan/0.1'

    def handle(self):
        # do_GET/do_POST are too late to catch failures in the initial readline.
        try:
            super().handle()
        except OSError as error:
            if error.errno not in CONNECTION_ERRNOS:
                raise
            self.close_connection = True
            self.server.report_transport_error(error)

    def log_message(self, format, *args):
        # Never log auth credentials, request bodies, or URL parameters.
        pass

    def send(self, code, data, content_type='application/json; charset=utf-8'):
        encoded = json.dumps(data, ensure_ascii=False).encode() if isinstance(data, dict) else data
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(encoded)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(encoded)

    def token(self):
        return self.headers.get('Authorization','').removeprefix('Bearer ')

    def do_GET(self):
        try:
            path = urlparse(self.path).path
            if path == '/api/health':
                return self.send(200, dict(ok=True, ai=bool(self.server.app.referee.key), model=self.server.app.referee.model))
            if path.startswith('/api/state/'):
                code = path.rsplit('/',1)[-1]
                with self.server.app.lock:
                    room, p = self.server.app.auth(code, self.token())
                    room.tick()
                    state = room.snapshot(p)
                return self.send(200, dict(state=state))
            allowed = {'/':'index.html','/app.js':'app.js','/style.css':'style.css','/favicon.svg':'favicon.svg'}
            if path in allowed:
                file = ROOT/'public'/allowed[path]
                mime = {'html':'text/html; charset=utf-8','css':'text/css; charset=utf-8','js':'text/javascript; charset=utf-8','svg':'image/svg+xml'}
                return self.send(200, file.read_bytes(), mime[file.suffix[1:]])
            self.send(404, dict(error='見つかりません。'))
        except GameError as e:
            self.send(403, dict(error=str(e)))
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        try:
            require(self.path == '/api/action', '操作が見つかりません。')
            origin = self.headers.get('Origin')
            require(not origin or origin == 'http://' + self.headers.get('Host',''), '別のサイトからは操作できません。')
            length = int(self.headers.get('Content-Length','0'))
            require(0 < length <= 4096, '送信内容が大きすぎます。')
            require('application/json' in self.headers.get('Content-Type',''), 'JSON形式で送信してください。')
            body = json.loads(self.rfile.read(length))
            require(isinstance(body, dict), '送信内容が不正です。')
            result = self.server.app.action(body, self.token())
            self.send(200, result)
        except GameError as e:
            self.send(400, dict(error=str(e)))
        except (ValueError, TypeError):
            self.send(400, dict(error='送信内容が不正です。'))
        except (BrokenPipeError, ConnectionResetError):
            pass


def make_server(host='0.0.0.0', port=8765, app=None):
    server = GameHTTPServer((host,port), Handler)
    server.app = app or App()
    return server


def main():
    parser = argparse.ArgumentParser(description='言ったもん雀 / 同じWi-Fiで4人対戦')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--host', default='0.0.0.0')
    parser.add_argument('--diagnose', action='store_true', help='空きポートでlocalhostとLANを診断して終了（API呼び出しなし）')
    args = parser.parse_args()
    server = make_server(args.host, 0 if args.diagnose else args.port)
    address = lan_address() if args.host == '0.0.0.0' else args.host
    if args.diagnose:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = check_network(server, address)
        finally:
            server.shutdown()
            thread.join()
            server.server_close()
        return 0 if result['localhost']['ok'] and result['lan'] and result['lan']['ok'] else 1
    print(f'\n  言ったもん雀 / http://localhost:{args.port}', flush=True)
    if address and not address.startswith('127.'):
        print(f'  同じWi-Fiの友達 → http://{address}:{args.port}', flush=True)
    print(f'  AI: {server.app.referee.model} / キー: {"設定済み" if server.app.referee.key else "未設定"}\n', flush=True)
    if address and not address.startswith('127.'):
        threading.Thread(target=check_network, args=(server, address), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n終了しました。')
    finally:
        server.server_close()

if __name__ == '__main__':
    sys.exit(main())
