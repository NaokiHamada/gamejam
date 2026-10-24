"""Regression tests for failures before do_GET/do_POST are entered."""
import contextlib
import errno
import io
import threading
import unittest
from unittest.mock import patch

from server import Handler, make_server, probe_http, check_network
from test_game import FakeReferee
from server import App


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.server = make_server('127.0.0.1', 0, App(FakeReferee()))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()

    def test_bad_descriptor_before_http_does_not_break_next_connection(self):
        original = Handler.handle_one_request
        remaining = [2]

        def fail_twice(handler):
            if remaining[0]:
                remaining[0] -= 1
                raise OSError(errno.EBADF, 'Bad file descriptor')
            return original(handler)

        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), patch.object(Handler, 'handle_one_request', fail_twice), patch.object(self.server, 'handle_error') as traceback:
            for _ in range(2):
                self.assertFalse(probe_http('127.0.0.1', self.port)['ok'])
            self.assertTrue(probe_http('127.0.0.1', self.port)['ok'])
            traceback.assert_not_called()
        # One actionable notice, even when multiple phone requests fail.
        self.assertEqual(stderr.getvalue().count('errno=9'), 1)
        self.assertNotIn('Traceback', stderr.getvalue())

    def test_browser_aborted_connection_is_normal_and_other_clients_survive(self):
        original = Handler.handle_one_request
        remaining = [1]

        def reset_once(handler):
            if remaining[0]:
                remaining[0] -= 1
                raise ConnectionResetError(errno.ECONNRESET, 'reset')
            return original(handler)

        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), patch.object(Handler, 'handle_one_request', reset_once), patch.object(self.server, 'handle_error') as traceback:
            self.assertFalse(probe_http('127.0.0.1', self.port)['ok'])
            self.assertTrue(probe_http('127.0.0.1', self.port)['ok'])
            traceback.assert_not_called()
        self.assertEqual(stderr.getvalue(), '')

    def test_unrelated_os_error_remains_visible(self):
        with patch.object(Handler, 'handle_one_request', side_effect=OSError(errno.EIO, 'unrelated')), patch.object(self.server, 'handle_error') as traceback:
            self.assertFalse(probe_http('127.0.0.1', self.port)['ok'])
            # Connection close occurs after handle_error, so this is synchronous.
            traceback.assert_called_once()

    def test_lan_diagnosis_distinguishes_localhost_from_lan(self):
        with patch('server.probe_http', side_effect=[dict(ok=True, errno=None), dict(ok=False, errno=errno.ECONNRESET)]), contextlib.redirect_stdout(io.StringIO()) as stdout:
            result = check_network(self.server, '192.0.2.2')
        self.assertTrue(result['localhost']['ok'])
        self.assertFalse(result['lan']['ok'])
        self.assertIn('localhost OK / LAN NG', stdout.getvalue())
        self.assertIn('ネットワークフィルター', stdout.getvalue())
        self.assertEqual(self.server.network_check, result)

    def test_probe_performs_http_without_a_proxy(self):
        with patch.dict('os.environ', {'http_proxy': 'http://127.0.0.1:1', 'HTTP_PROXY': 'http://127.0.0.1:1'}):
            self.assertTrue(probe_http('127.0.0.1', self.port)['ok'])

if __name__ == '__main__':
    unittest.main()
