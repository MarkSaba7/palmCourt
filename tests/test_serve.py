"""Tests for serve.py: phone address choice, firewall reading, the WebSocket relay and the phone https server.

    python -m unittest discover -s tests -v        (from the palm-court folder)
"""
import base64
import json
import os
import socket
import ssl
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import serve  # noqa: E402

IPCONFIG_EN = '''
Windows IP Configuration


Ethernet adapter Ethernet:

   Connection-specific DNS Suffix  . :
   Link-local IPv6 Address . . . . . : fe80::3348:8c70:802b:da17%21
   IPv4 Address. . . . . . . . . . . : 192.168.68.101
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . : 192.168.68.1

Wireless LAN adapter Local Area Connection* 1:

   Media State . . . . . . . . . . . : Media disconnected
   Connection-specific DNS Suffix  . :

Ethernet adapter VMware Network Adapter VMnet1:

   Connection-specific DNS Suffix  . :
   Link-local IPv6 Address . . . . . : fe80::853d:d90c:4530:c744%13
   IPv4 Address. . . . . . . . . . . : 192.168.152.1
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . :

Ethernet adapter VMware Network Adapter VMnet8:

   Connection-specific DNS Suffix  . :
   IPv4 Address. . . . . . . . . . . : 192.168.175.1
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . :

Wireless LAN adapter Wi-Fi:

   Media State . . . . . . . . . . . : Media disconnected
   Connection-specific DNS Suffix  . :
'''

IPCONFIG_DE = '''
Windows-IP-Konfiguration

Ethernet-Adapter vEthernet (WSL):

   Verbindungsspezifisches DNS-Suffix:
   IPv4-Adresse  . . . . . . . . . . : 172.29.64.1
   Subnetzmaske  . . . . . . . . . . : 255.255.240.0
   Standardgateway . . . . . . . . . :

Drahtlos-LAN-Adapter WLAN:

   Verbindungsspezifisches DNS-Suffix: fritz.box
   IPv6-Adresse. . . . . . . . . . . : 2a02:810d:1234::5
   IPv4-Adresse  . . . . . . . . . . : 192.168.178.34
   Subnetzmaske  . . . . . . . . . . : 255.255.255.0
   Standardgateway . . . . . . . . . : fe80::1%14
                                       192.168.178.1
'''


def ad(ip, name, gateway=False, desc='', down=False):
    return {'ip': ip, 'name': name, 'desc': desc, 'gateway': gateway, 'down': down}


class ChooseIps(unittest.TestCase):
    def best(self, ads, route=None):
        got = serve.choose_ips(ads, route)
        return got[0]['ip'] if got else None

    def test_this_pc(self):
        ads = [ad('192.168.175.1', 'VMware Network Adapter VMnet8', desc='VMware Virtual Ethernet Adapter for VMnet8'),
               ad('192.168.152.1', 'VMware Network Adapter VMnet1', desc='VMware Virtual Ethernet Adapter for VMnet1'),
               ad('169.254.198.79', 'Local Area Connection* 2'),
               ad('192.168.68.101', 'Ethernet', True, 'Realtek PCIe GbE Family Controller'),
               ad('10.0.0.242', 'Wi-Fi', True, 'Realtek 8821CE Wireless LAN', down=True),
               ad('127.0.0.1', 'Loopback Pseudo-Interface 1')]
        got = serve.choose_ips(ads, '192.168.68.101')
        self.assertEqual([a['ip'] for a in got], ['192.168.68.101'])   # no VMware, no stale Wi-Fi, no loopback

    def test_virtual_adapter_listed_first_and_on_the_route(self):
        ads = [ad('192.168.152.1', 'VMware Network Adapter VMnet1'), ad('192.168.1.20', 'Wi-Fi', True)]
        self.assertEqual(self.best(ads, '192.168.152.1'), '192.168.1.20')

    def test_wsl_and_hyperv_skipped(self):
        ads = [ad('172.29.64.1', 'vEthernet (WSL)', desc='Hyper-V Virtual Ethernet Adapter'),
               ad('172.23.0.1', 'vEthernet (Default Switch)', desc='Hyper-V Virtual Ethernet Adapter #2'),
               ad('192.168.1.20', 'Wi-Fi', True, 'Intel(R) Wi-Fi 6 AX201')]
        self.assertEqual([a['ip'] for a in serve.choose_ips(ads, '192.168.1.20')], ['192.168.1.20'])

    def test_virtualbox_docker_vpn_skipped(self):
        ads = [ad('192.168.56.1', 'VirtualBox Host-Only Network'), ad('10.8.0.2', 'OpenVPN TAP-Windows6'),
               ad('100.101.5.9', 'Tailscale'), ad('172.17.0.1', 'docker0'), ad('192.168.0.7', 'Ethernet', True)]
        self.assertEqual([a['ip'] for a in serve.choose_ips(ads, '10.8.0.2')], ['192.168.0.7'])

    def test_second_real_adapter_is_an_alternative(self):
        ads = [ad('10.0.0.5', 'Wi-Fi'), ad('192.168.1.9', 'Ethernet', True)]
        self.assertEqual([a['ip'] for a in serve.choose_ips(ads, '192.168.1.9')], ['192.168.1.9', '10.0.0.5'])

    def test_only_virtual_still_gives_something(self):
        self.assertEqual(self.best([ad('192.168.152.1', 'VMware Network Adapter VMnet1')]), '192.168.152.1')

    def test_route_only(self):
        self.assertEqual(self.best([], '192.168.1.44'), '192.168.1.44')

    def test_nothing(self):
        self.assertIsNone(self.best([ad('169.254.3.4', 'Ethernet'), ad('127.0.0.1', 'lo')], None))

    def test_garbage_ignored(self):
        self.assertEqual(self.best([ad('', 'x'), ad('not an ip', 'y'), ad('192.168.1.2', 'Wi-Fi', True)]), '192.168.1.2')


class ParseIpconfig(unittest.TestCase):
    def test_english(self):
        got = serve.parse_ipconfig(IPCONFIG_EN)
        self.assertEqual([(a['ip'], a['name'], a['gateway']) for a in got],
                         [('192.168.68.101', 'Ethernet', True),
                          ('192.168.152.1', 'VMware Network Adapter VMnet1', False),
                          ('192.168.175.1', 'VMware Network Adapter VMnet8', False)])
        self.assertEqual(serve.choose_ips(got, None)[0]['ip'], '192.168.68.101')

    def test_german_with_ipv6_gateway_first(self):
        got = serve.parse_ipconfig(IPCONFIG_DE)
        self.assertEqual([(a['ip'], a['gateway']) for a in got], [('172.29.64.1', False), ('192.168.178.34', True)])
        self.assertEqual([a['ip'] for a in serve.choose_ips(got, None)], ['192.168.178.34'])


class Firewall(unittest.TestCase):
    def info(self, category='Public', rules=(), enabled=('Domain', 'Private', 'Public')):
        return {'networks': [{'name': 'Ethernet', 'category': category}], 'enabled': list(enabled), 'rules': list(rules)}

    def test_allowed_on_public(self):
        self.assertEqual(serve.firewall_verdict(self.info(rules=[{'action': 'Allow', 'profile': 'Public'}])), 'ok')

    def test_only_private_allowed_on_a_public_network(self):
        # What happens when you accept Windows' first prompt with its default tick (Private only).
        rules = [{'action': 'Allow', 'profile': 'Private'}, {'action': 'Block', 'profile': 'Public'}]
        self.assertEqual(serve.firewall_verdict(self.info(rules=rules)), 'blocked')

    def test_block_beats_allow(self):
        rules = [{'action': 'Allow', 'profile': 'Any'}, {'action': 'Block', 'profile': 'Private, Public'}]
        self.assertEqual(serve.firewall_verdict(self.info('Private', rules)), 'blocked')

    def test_no_rule(self):
        self.assertEqual(serve.firewall_verdict(self.info('Private')), 'blocked')

    def test_port_rule(self):
        self.assertEqual(serve.firewall_verdict(self.info('Private', [{'action': 'Allow', 'profile': 'Any', 'port': True}])), 'ok')

    def test_firewall_off_for_this_network(self):
        self.assertEqual(serve.firewall_verdict(self.info('Public', enabled=['Domain', 'Private'])), 'ok')

    def test_domain_network(self):
        self.assertEqual(serve.firewall_verdict(self.info('DomainAuthenticated', [{'action': 'Allow', 'profile': 'Domain, Private'}])), 'ok')

    def test_store_python_is_unknown(self):
        exe = r'C:\Users\x\AppData\Local\Microsoft\WindowsApps\PythonSoftwareFoundation.Python.3.12_qbz5n2kfra8p0\python.exe'
        self.assertEqual(serve.firewall_verdict(self.info('Private'), exe), 'unknown')

    def test_no_data(self):
        self.assertEqual(serve.firewall_verdict(None), 'unknown')
        self.assertEqual(serve.firewall_verdict({'networks': []}), 'unknown')


class WebSocketFrames(unittest.TestCase):
    def test_accept_key_rfc6455_example(self):
        self.assertEqual(serve.ws_accept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')

    def test_round_trip_and_partial(self):
        for n in (0, 5, 125, 126, 300, 70000):
            payload = os.urandom(n)
            buf = bytearray(masked(payload))
            self.assertEqual(serve.ws_parse(buf[:1]), [])
            got = serve.ws_parse(buf)
            self.assertEqual(got, [(True, 1, payload)])
            self.assertEqual(len(buf), 0)
        buf = bytearray(serve.ws_frame('hi') + serve.ws_frame('there')[:3])
        self.assertEqual(serve.ws_parse(buf), [(True, 1, b'hi')])
        self.assertEqual(len(buf), 3)


def masked(payload, opcode=1, fin=True):
    mask = os.urandom(4)
    n = len(payload)
    head = bytes([(0x80 if fin else 0) | opcode])
    head += bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + n.to_bytes(2, 'big') if n < 65536 else bytes([0x80 | 127]) + n.to_bytes(8, 'big')
    return head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload))


class WsClient:
    """Just enough of a browser WebSocket for the tests."""

    def __init__(self, port, path, tls=None):
        s = socket.create_connection(('127.0.0.1', port), timeout=5)
        self.sock = tls.wrap_socket(s, server_hostname='localhost') if tls else s
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f'GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                           f'Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
        head = b''
        while b'\r\n\r\n' not in head:
            c = self.sock.recv(1)
            if not c:
                break
            head += c
        self.status = head.split(b'\r\n', 1)[0].decode()
        self.ok = ' 101 ' in self.status and serve.ws_accept(key).encode() in head
        self.buf, self.closed = bytearray(), False

    def send(self, obj):
        self.sock.sendall(masked(json.dumps(obj).encode()))

    def recv(self, timeout=3):
        end = time.time() + timeout
        while time.time() < end:
            for fin, op, data in serve.ws_parse(self.buf):
                if op == 0x8:
                    self.closed = True
                    return None
                if op == 0x1:
                    return json.loads(data)
            self.sock.settimeout(max(0.05, end - time.time()))
            try:
                chunk = self.sock.recv(4096)
            except (socket.timeout, ssl.SSLError):
                continue
            if not chunk:
                self.closed = True
                return None
            self.buf += chunk
        return 'timeout'

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


class RelayOverHttp(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = serve.Server(('127.0.0.1', 0), serve.Handler)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def ws(self, role, code):
        c = WsClient(self.port, f'/link?role={role}&code={code}')
        self.assertTrue(c.ok, c.status)
        self.addCleanup(c.close)
        return c

    def test_pair_forward_and_leave(self):
        game = self.ws('game', 'ABCDE')
        phone = self.ws('phone', 'abcde')                 # codes are case-insensitive
        self.assertEqual(phone.recv(), {'relay': 'open'})
        self.assertEqual(game.recv(), {'relay': 'open'})
        phone.send({'type': 'swing', 'dir': 'bh', 'power': 0.8})
        self.assertEqual(game.recv(), {'type': 'swing', 'dir': 'bh', 'power': 0.8})
        game.send({'type': 'hit', 'power': 0.5})
        self.assertEqual(phone.recv(), {'type': 'hit', 'power': 0.5})
        phone.close()
        self.assertEqual(game.recv(), {'relay': 'close'})

    def test_phone_waits_for_the_game(self):
        phone = self.ws('phone', 'WAIT1')
        self.assertEqual(phone.recv(), {'relay': 'wait'})
        game = self.ws('game', 'WAIT1')
        self.assertEqual(phone.recv(), {'relay': 'open'})
        self.assertEqual(game.recv(), {'relay': 'open'})

    def test_newest_phone_wins_and_old_one_is_told(self):
        game = self.ws('game', 'NEWPH')
        a = self.ws('phone', 'NEWPH')
        self.assertEqual(a.recv(), {'relay': 'open'})
        self.assertEqual(game.recv(), {'relay': 'open'})
        b = self.ws('phone', 'NEWPH')
        self.assertEqual(a.recv(), {'type': 'replaced'})
        self.assertIsNone(a.recv())
        self.assertEqual(b.recv(), {'relay': 'open'})
        self.assertEqual(game.recv(), {'relay': 'open'})
        b.send({'type': 'ping', 't': 1})
        self.assertEqual(game.recv(), {'type': 'ping', 't': 1})

    def test_reloaded_game_tab_takes_over(self):
        old = self.ws('game', 'RELOA')
        phone = self.ws('phone', 'RELOA')
        self.assertEqual(phone.recv(), {'relay': 'open'})
        self.assertEqual(old.recv(), {'relay': 'open'})
        new = self.ws('game', 'RELOA')
        self.assertEqual(old.recv(), {'relay': 'replaced'})
        self.assertEqual(new.recv(), {'relay': 'open'})
        self.assertEqual(phone.recv(), {'relay': 'open'})

    def test_game_can_kick_phone_but_phone_cannot_fake_relay_messages(self):
        game = self.ws('game', 'KICKS')
        phone = self.ws('phone', 'KICKS')
        phone.recv(), game.recv()
        phone.send({'relay': 'open'})
        phone.send({'type': 'hello'})
        self.assertEqual(game.recv(), {'type': 'hello'})    # the fake relay message never arrived
        game.send({'relay': 'kick'})
        self.assertIsNone(phone.recv())
        self.assertEqual(game.recv(), {'relay': 'close'})

    def test_bad_requests_refused(self):
        for path in ('/link?role=phone&code=TOOLONG', '/link?role=admin&code=ABCDE', '/link?role=phone'):
            c = WsClient(self.port, path)
            self.addCleanup(c.close)
            self.assertFalse(c.ok)
            self.assertIn('400', c.status)

    def test_lan_json_and_blocked_files(self):
        with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/lan.json') as r:
            info = json.loads(r.read())
        self.assertTrue(info['relay'])
        for path in ('/serve.py', '/play.cmd', '/.claude/launch.json', '/__pycache__/serve.cpython-312.pyc', '/tests/test_serve.py', '/src/'):
            with self.assertRaises(urllib.error.HTTPError, msg=path) as e:
                urllib.request.urlopen(f'http://127.0.0.1:{self.port}{path}')
            self.assertEqual(e.exception.code, 404)
        with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/controller.html') as r:
            self.assertEqual(r.status, 200)
            self.assertEqual(r.headers['Cache-Control'], 'no-store')

    @unittest.skipUnless(sys.platform == 'win32', 'Windows port sharing')
    def test_second_server_cannot_share_the_port(self):
        with self.assertRaises(OSError):
            serve.Server(('127.0.0.1', self.port), serve.Handler)


@unittest.skipUnless(serve.find_openssl(), 'needs openssl')
class PhoneHttps(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cert, key = serve.ensure_cert(['127.0.0.1', '192.168.1.20'], cls.tmp.name)
        cls.cert = cert
        cls.srv = serve.PhoneServer(('127.0.0.1', 0), serve.Handler)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(str(cert), str(key))
        cls.srv.ctx = ctx
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.tls = ssl._create_unverified_context()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.tmp.cleanup()

    def get(self, path):
        req = urllib.request.Request(f'https://127.0.0.1:{self.port}{path}')
        opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=self.tls), NoRedirect)
        try:
            with opener.open(req, timeout=5) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), b''

    def test_certificate(self):
        pem = self.cert.read_text()
        der = ssl.PEM_cert_to_DER_cert(pem)
        self.assertIn(b'Palm Court local', der)
        text = serve.run([serve.find_openssl(), 'x509', '-in', str(self.cert), '-noout', '-text'])
        self.assertIn('IP Address:192.168.1.20', text)
        self.assertIn('TLS Web Server Authentication', text)
        self.assertIn('CA:FALSE', text)
        # Same addresses: the certificate is reused (the phone doesn't have to accept a new one).
        again = serve.ensure_cert(['192.168.1.20', '127.0.0.1'], self.tmp.name)
        self.assertEqual(again[0].read_text(), pem)

    def test_pages(self):
        self.assertEqual(self.get('/controller.html')[0], 200)
        status, headers, _ = self.get('/?c=ABCDE')
        self.assertEqual(status, 302)
        self.assertEqual(headers['Location'], '/controller.html?c=ABCDE')
        for path in ('/serve.py', '/play.cmd', '/.claude/launch.json'):
            self.assertEqual(self.get(path)[0], 404, path)

    def test_plain_http_is_sent_to_https(self):
        s = socket.create_connection(('127.0.0.1', self.port), timeout=5)
        s.sendall(b'GET /controller.html?c=ABCDE HTTP/1.1\r\nHost: 192.168.1.20:8766\r\n\r\n')
        head = s.recv(4096).decode()
        s.close()
        self.assertIn('301', head.split('\r\n')[0])
        self.assertIn('Location: https://192.168.1.20:' + str(self.port) + '/controller.html?c=ABCDE', head)

    def test_refused_certificate_is_noted(self):
        serve.SEEN.clear()
        s = socket.create_connection(('127.0.0.1', self.port), timeout=5)
        strict = ssl.create_default_context()           # like a phone that hasn't accepted the certificate yet
        with self.assertRaises(ssl.SSLError):
            strict.wrap_socket(s, server_hostname='localhost')
        s.close()
        self.assertIsNone(serve.latest_contact())        # from this PC itself: not a phone
        serve.note_contact('192.168.1.55', 'tls')
        serve.note_contact('192.168.1.55', 'page')
        serve.note_contact('192.168.1.55', 'tls')        # a later refusal doesn't undo progress
        self.assertEqual(serve.latest_contact()['stage'], 'page')
        serve.note_contact('192.168.1.55', 'link')
        self.assertEqual(serve.latest_contact()['ip'], '192.168.1.55')
        self.assertEqual(serve.latest_contact()['stage'], 'link')
        serve.SEEN.clear()

    def test_relay_over_tls(self):
        game = WsClient(self.port, '/link?role=game&code=TLSOK', self.tls)
        phone = WsClient(self.port, '/link?role=phone&code=TLSOK', self.tls)
        self.addCleanup(game.close)
        self.addCleanup(phone.close)
        self.assertTrue(game.ok and phone.ok)
        self.assertEqual(phone.recv(), {'relay': 'open'})
        self.assertEqual(game.recv(), {'relay': 'open'})
        for i in range(50):
            phone.send({'type': 'ping', 't': i})
        for i in range(50):
            self.assertEqual(game.recv(), {'type': 'ping', 't': i})
        game.send({'type': 'hit', 'power': 1})
        self.assertEqual(phone.recv(), {'type': 'hit', 'power': 1})


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


if __name__ == '__main__':
    unittest.main()
