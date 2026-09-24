#!/usr/bin/env python3
"""Palm Court dev server.

    http://localhost:8765                      play on this PC
    https://<this PC's network address>:8766   the phone racket page, for phones on the same Wi-Fi

Phones only hand motion sensors to https pages, so the phone server uses a certificate made on this
PC the first time you run it (with the openssl that ships with Git for Windows). Your phone warns about
it: tap Advanced then Proceed (Android) or Show Details then visit this website (iPhone).

The phone and the game talk through this server (/link, a small WebSocket relay), so pairing needs no
internet. The game also listens over PeerJS, for when this server can't be used.
"""
import argparse
import base64
import hashlib
import http.server
import ipaddress
import json
import os
import re
import select
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PC_PORT = 8765
PHONE_PORT = 8766
CERT_DIR = Path.home() / '.palm-court-dev'   # outside the served folder, so the private key is never served
CERT_VERSION = 'v2'
LOCK = threading.Lock()
STATE = {'urls': [], 'problem': None, 'firewall': None, 'own': set()}
SEEN = {}                                     # phone address -> {'stage', 't'}
STAGES = ('tls', 'page', 'link')              # reached this PC, opened the racket page, linked to the game


# ---------- which address should the phone use? ----------
# Phones can't reach virtual adapters (VMware, VirtualBox, Hyper-V, WSL) or VPN tunnels, but they often have
# the lowest interface numbers, so a naive pick puts an unreachable address in the QR code.
VIRTUAL = re.compile(r'vmware|virtualbox|vbox|hyper-v|vethernet|\bwsl|docker|loopback|pseudo-interface|\btap\b|tap-windows|'
                     r'tunnel|vpn|wireguard|tailscale|zerotier|hamachi|radmin|npcap|bluetooth|teredo|isatap|parallels|'
                     r'virbr|\bveth|\bbr-|nordlynx|openvpn|fortinet|anyconnect|globalprotect', re.I)
CGNAT = ipaddress.IPv4Network('100.64.0.0/10')


def usable(ip):
    try:
        a = ipaddress.IPv4Address(ip)
    except (ValueError, TypeError):
        return False
    return not (a.is_loopback or a.is_link_local or a.is_unspecified or a.is_multicast)


def rank(ad, route):
    """Higher means more likely to be the address a phone on the same Wi-Fi can reach."""
    ip, label = ipaddress.IPv4Address(ad['ip']), f"{ad.get('name', '')} {ad.get('desc', '')}"
    score = 0
    if ad.get('gateway'):
        score += 40          # the adapter with the default gateway is the real network
    if ad['ip'] == route:
        score += 20          # the one this PC uses to reach the internet
    if ip.is_private:
        score += 10
    if ip in CGNAT:
        score -= 30          # carrier NAT and Tailscale
    if VIRTUAL.search(label):
        score -= 100
    if ad.get('down'):
        score -= 100         # a disconnected adapter can keep its old address
    return score


def choose_ips(adapters, route=None):
    """This PC's addresses, best first. Virtual adapters only come back when there's nothing else."""
    seen, cands = set(), []
    for ad in list(adapters) + ([{'ip': route, 'name': ''}] if route else []):
        ip = ad.get('ip')
        if not usable(ip) or ip in seen:
            continue
        seen.add(ip)
        cands.append(dict(ad, score=rank(ad, route)))
    cands.sort(key=lambda a: -a['score'])
    real = [a for a in cands if a['score'] > -50]
    return real or cands[:1]


def run(cmd, timeout=15, env=None):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, errors='replace', timeout=timeout, env=env,
                           creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        return r.stdout if r.returncode == 0 else ''
    except (OSError, subprocess.SubprocessError):
        return ''


def powershell(script, env=None):
    return run(['powershell', '-NoProfile', '-NonInteractive', '-Command', script], env=env)


PS_ADAPTERS = r'''
$ErrorActionPreference = 'SilentlyContinue'
$gw = @{}
Get-NetRoute -DestinationPrefix '0.0.0.0/0' | ForEach-Object { $gw[[int]$_.InterfaceIndex] = $true }
$out = @(Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object {
  $a = Get-NetAdapter -InterfaceIndex $_.InterfaceIndex
  @{ ip = [string]$_.IPAddress; name = [string]$_.InterfaceAlias; desc = [string]$a.InterfaceDescription;
     down = ($a -and [string]$a.Status -ne 'Up'); gateway = [bool]$gw[[int]$_.InterfaceIndex] }
})
ConvertTo-Json -InputObject $out -Compress
'''


def windows_adapters():
    try:
        out = json.loads(powershell(PS_ADAPTERS) or 'null')
    except ValueError:
        return []
    out = [out] if isinstance(out, dict) else out or []
    return [a for a in out if isinstance(a, dict) and a.get('ip')]


def parse_ipconfig(text):
    """Plain `ipconfig` output, in any language: fast, and it leaves out disconnected adapters."""
    out, cur = [], None
    for line in text.splitlines():
        if line and not line[0].isspace() and line.rstrip().endswith(':'):
            full = line.strip().rstrip(':').strip()
            cur = {'name': re.sub(r'^.*?\badapter\s+', '', full, flags=re.I), 'desc': full, 'ip': None, 'gateway': False}
            out.append(cur)
            continue
        m = re.search(r'\b(\d{1,3}(?:\.\d{1,3}){3})\b', line)
        if not cur or not m:
            continue
        ip = m.group(1)
        if 'IPv4' in line and not cur['ip']:
            cur['ip'] = ip
        elif cur['ip'] and not ip.startswith('255.') and ip != '0.0.0.0':
            cur['gateway'] = True    # after the address and subnet mask, the next address is the default gateway
    return [a for a in out if a['ip']]


def unix_adapters():
    gw = set(re.findall(r'\bdev (\S+)', run(['ip', 'route', 'show', 'default'])))
    return [{'ip': m.group(2), 'name': m.group(1), 'gateway': m.group(1) in gw}
            for m in re.finditer(r'^\d+:\s+(\S+)\s+inet (\d+\.\d+\.\d+\.\d+)', run(['ip', '-o', '-4', 'addr', 'show']), re.M)]


def route_ip():
    """The address this PC would use to reach the internet (connecting a UDP socket sends nothing)."""
    for target in ('8.8.8.8', '10.255.255.255'):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect((target, 80))
            ip = s.getsockname()[0]
            if usable(ip):
                return ip
        except OSError:
            pass
        finally:
            s.close()
    return None


def adapters():
    if sys.platform == 'win32':
        found = parse_ipconfig(run(['ipconfig']))
        return found if any(usable(a['ip']) for a in found) else windows_adapters()
    return unix_adapters()


def lan_ip():
    best = choose_ips(adapters(), route_ip())
    return best[0]['ip'] if best else None


# ---------- certificate ----------
def find_openssl():
    for c in (r'C:\Program Files\Git\mingw64\bin\openssl.exe',
              r'C:\Program Files\Git\usr\bin\openssl.exe',
              r'C:\Program Files (x86)\Git\mingw64\bin\openssl.exe',
              shutil.which('openssl')):
        if c and Path(c).is_file():
            return c
    return None


def cert_config(ips):
    san = ','.join([f'IP:{ip}' for ip in ips] + ['DNS:localhost'])
    # A plain server certificate (not a CA): iPhones insist on serverAuth, and a validity of 825 days or less.
    return ('[req]\ndistinguished_name = dn\nx509_extensions = ext\nprompt = no\n'
            '[dn]\nCN = Palm Court local\n'
            f'[ext]\nsubjectAltName = {san}\nbasicConstraints = critical,CA:FALSE\n'
            'keyUsage = critical,digitalSignature,keyEncipherment\nextendedKeyUsage = serverAuth\n'
            'subjectKeyIdentifier = hash\n')


def ensure_cert(ips, folder=None):
    folder = Path(folder or CERT_DIR)
    cert, key, stamp = folder / 'cert.pem', folder / 'key.pem', folder / 'ip.txt'
    want = CERT_VERSION + ' ' + ' '.join(sorted(ips))
    try:
        if cert.is_file() and key.is_file() and stamp.read_text().strip() == want:
            return cert, key
    except OSError:
        pass
    openssl = find_openssl()
    if not openssl:
        return None
    folder.mkdir(exist_ok=True)
    cfg, tmp_cert, tmp_key = folder / 'openssl.cnf', folder / 'cert.tmp', folder / 'key.tmp'
    cfg.write_text(cert_config(ips))
    r = subprocess.run([openssl, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '825', '-sha256',
                        '-config', str(cfg), '-keyout', str(tmp_key), '-out', str(tmp_cert)],
                       capture_output=True, text=True, errors='replace')
    if r.returncode != 0:
        print(r.stderr.strip())
        return None
    os.replace(tmp_key, key)
    os.replace(tmp_cert, cert)
    stamp.write_text(want)
    return cert, key


# ---------- is Windows Firewall letting phones in? (read only: this never changes any setting) ----------
PS_FIREWALL = r'''
$ErrorActionPreference = 'SilentlyContinue'
$exe = $env:PALM_EXE; $port = $env:PALM_PORT
$nets = @(Get-NetConnectionProfile | ForEach-Object { @{ name = [string]$_.InterfaceAlias; category = [string]$_.NetworkCategory } })
$on = @(Get-NetFirewallProfile | Where-Object { [string]$_.Enabled -eq 'True' } | ForEach-Object { [string]$_.Name })
$rules = @()
foreach ($f in Get-NetFirewallApplicationFilter) {
  if ($f.Program -and ([Environment]::ExpandEnvironmentVariables($f.Program) -ieq $exe)) {
    $r = $f | Get-NetFirewallRule
    if ([string]$r.Enabled -eq 'True' -and [string]$r.Direction -eq 'Inbound') { $rules += @{ action = [string]$r.Action; profile = [string]$r.Profile } }
  }
}
foreach ($f in Get-NetFirewallPortFilter) {
  if ([string]$f.Protocol -eq 'TCP' -and (@($f.LocalPort) -contains $port)) {
    $r = $f | Get-NetFirewallRule
    if ([string]$r.Enabled -eq 'True' -and [string]$r.Direction -eq 'Inbound') { $rules += @{ action = [string]$r.Action; profile = [string]$r.Profile; port = $true } }
  }
}
ConvertTo-Json -InputObject @{ networks = $nets; enabled = $on; rules = $rules } -Compress -Depth 4
'''


def firewall_verdict(info, exe=''):
    """'ok', 'blocked' (no rule lets this Python in on the current network, or one blocks it), or 'unknown'."""
    if not isinstance(info, dict):
        return 'unknown'
    cats = [{'DomainAuthenticated': 'Domain'}.get(n.get('category'), n.get('category')) for n in info.get('networks') or []]
    on = set(info.get('enabled') or [])
    active = [c for c in cats if c in on]
    if not cats:
        return 'unknown'
    if not active:
        return 'ok'                    # the firewall is off for this network

    def covers(rule, cat):
        p = rule.get('profile', '')
        return p == 'Any' or cat in [x.strip() for x in p.split(',')]

    rules = info.get('rules') or []
    if any(r.get('action') == 'Block' and covers(r, c) for r in rules for c in active):
        return 'blocked'               # block rules win over allow rules
    if all(any(r.get('action') == 'Allow' and covers(r, c) for r in rules) for c in active):
        return 'ok'
    # Store Python's firewall rules name the real program, not the alias in sys.executable: can't tell.
    return 'unknown' if 'windowsapps' in exe.lower() else 'blocked'


def check_firewall(port):
    exe = sys.executable.replace('/', '\\')     # MSYS2 Python reports C:/msys64/..., rules say C:\msys64\...
    raw = powershell(PS_FIREWALL, env=dict(os.environ, PALM_EXE=exe, PALM_PORT=str(port)))
    try:
        info = json.loads(raw) if raw.strip() else None
    except ValueError:
        info = None
    nets = [n for n in (info or {}).get('networks') or [] if isinstance(n, dict)]
    return {'state': firewall_verdict(info, exe), 'exe': exe, 'port': port,
            'networks': [{'name': n.get('name', ''), 'category': n.get('category', '')} for n in nets]}


def firewall_advice(fw):
    nets = ', '.join(f"\"{n['name']}\" ({n['category']})" for n in fw['networks']) or 'your network'
    public = any(n['category'] == 'Public' for n in fw['networks'])
    lines = [f'  Windows Firewall is probably blocking phones from this PC. Network: {nets}.',
             '  Fix it one of these ways (Palm Court never changes these settings itself):']
    if public:
        lines.append('    - Make your home network Private: Settings > Network & internet > (your connection) >'
                     ' Network profile type > Private. Then restart play.cmd and allow Python if asked.')
    lines += ['    - Or allow Python: Windows Security > Firewall & network protection > Allow an app through firewall >',
              f"      Change settings > tick Private{' and Public' if public else ''} for Python ({fw['exe']}).",
              '    - Or, in a terminal opened with "Run as administrator", allow just this port on your home network:',
              f'      netsh advfirewall firewall add rule name="Palm Court phone" dir=in action=allow protocol=TCP'
              f' localport={fw["port"]} remoteip=localsubnet']
    return '\n'.join(lines)


# ---------- phones that reached this PC (so the game screen can say how far pairing got) ----------
def is_local(ip):
    return ip.startswith('127.') or ip == '::1' or ip in STATE['own']


def note_contact(ip, stage):
    if is_local(ip):
        return
    now = time.time()
    with LOCK:
        s = SEEN.get(ip)
        fresh = not s or now - s['t'] > 600
        if fresh or STAGES.index(stage) > STAGES.index(s['stage']):
            SEEN[ip] = {'stage': stage, 't': now}
            say = True
        else:
            s['t'] = now
            say = False
    if say:
        print({'tls': f'  Phone {ip} reached this PC. Waiting for it to get past the certificate warning.',
               'page': f'  Phone {ip} opened the racket page.',
               'link': f'  Phone {ip} is linked to the game.'}[stage])


def latest_contact():
    with LOCK:
        if not SEEN:
            return None
        ip, s = max(SEEN.items(), key=lambda kv: kv[1]['t'])
        return {'ip': ip, 'stage': s['stage'], 'ago': round(time.time() - s['t'], 1)}


# ---------- WebSocket relay between the game tab and the phone ----------
WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'


def ws_accept(key):
    return base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()


def ws_frame(payload, opcode=0x1):
    if isinstance(payload, str):
        payload = payload.encode()
    n = len(payload)
    head = bytes([0x80 | opcode])
    if n < 126:
        head += bytes([n])
    elif n < 65536:
        head += bytes([126]) + n.to_bytes(2, 'big')
    else:
        head += bytes([127]) + n.to_bytes(8, 'big')
    return head + payload


def ws_parse(buf):
    """Takes complete frames off the front of buf (a bytearray): [(fin, opcode, payload)]."""
    frames = []
    while len(buf) >= 2:
        n, i = buf[1] & 0x7f, 2
        if n == 126:
            if len(buf) < 4:
                break
            n, i = int.from_bytes(buf[2:4], 'big'), 4
        elif n == 127:
            if len(buf) < 10:
                break
            n, i = int.from_bytes(buf[2:10], 'big'), 10
        mask = None
        if buf[1] & 0x80:
            if len(buf) < i + 4:
                break
            mask, i = bytes(buf[i:i + 4]), i + 4
        if len(buf) < i + n:
            break
        data = bytes(buf[i:i + n])
        if mask:
            data = (int.from_bytes(data, 'big') ^ int.from_bytes((mask * (n // 4 + 1))[:n], 'big')).to_bytes(n, 'big')
        frames.append((bool(buf[0] & 0x80), buf[0] & 0x0f, data))
        del buf[:i + n]
    return frames


class WsPeer:
    def __init__(self, sock, role, code):
        self.sock, self.role, self.code = sock, role, code
        self.buf, self.frag, self.last = bytearray(), None, time.monotonic()
        self.done = threading.Event()


class Relay:
    """Pairs each game tab with its phone by code and passes their messages along. One thread owns every
    socket, so a TLS socket is never read and written from two threads at once."""

    def __init__(self):
        self.rooms, self.peers, self.new = {}, {}, []
        self.lock = threading.Lock()
        self.wake_r, self.wake_w = socket.socketpair()
        self.wake_r.setblocking(False)
        threading.Thread(target=self.loop, daemon=True).start()

    def adopt(self, sock, role, code):
        p = WsPeer(sock, role, code)
        with self.lock:
            self.new.append(p)
        self.wake_w.send(b'x')
        return p.done

    def loop(self):
        last_ping = time.monotonic()
        while True:
            ready = [s for s in self.peers if isinstance(s, ssl.SSLSocket) and s.pending()]   # already decrypted
            if not ready:
                try:
                    ready, _, _ = select.select([self.wake_r] + list(self.peers), [], [], 5)
                except (OSError, ValueError):
                    for p in [p for p in self.peers.values() if p.sock.fileno() < 0]:
                        self.drop(p)
                    continue
            for s in ready:
                if s is self.wake_r:
                    self.take_new()
                elif s in self.peers:
                    self.read(self.peers[s])
            now = time.monotonic()
            if now - last_ping > 15:
                last_ping = now
                for p in list(self.peers.values()):
                    if now - p.last > 50:
                        self.drop(p)                          # a phone that vanished without closing
                    else:
                        self.write(p, ws_frame(b'', 0x9))     # browsers answer pings by themselves

    def take_new(self):
        try:
            while self.wake_r.recv(256):
                pass
        except OSError:
            pass
        with self.lock:
            new, self.new = self.new, []
        for p in new:
            p.sock.setblocking(False)
            self.peers[p.sock] = p
            self.join(p)

    def join(self, p):
        room = self.rooms.setdefault(p.code, {'game': None, 'phone': None})
        old, room[p.role] = room[p.role], p
        other = room['phone' if p.role == 'game' else 'game']
        if old:
            # The newest wins: a reloaded game tab, or the phone coming back (maybe before its old socket timed out).
            self.send(old, {'type': 'replaced'} if p.role == 'phone' else {'relay': 'replaced'})
            self.drop(old)
        if other:
            self.send(p, {'relay': 'open'})
            self.send(other, {'relay': 'open'})
        elif p.role == 'phone':
            self.send(p, {'relay': 'wait'})

    def drop(self, p):
        if self.peers.pop(p.sock, None) is None:
            return
        self.write(p, ws_frame(b'\x03\xe8', 0x8))
        try:
            p.sock.close()
        except OSError:
            pass
        p.done.set()
        room = self.rooms.get(p.code)
        if room and room.get(p.role) is p:
            room[p.role] = None
            other = room['phone' if p.role == 'game' else 'game']
            if other:
                self.send(other, {'relay': 'close'})
            elif not room['game'] and not room['phone']:
                del self.rooms[p.code]

    def read(self, p):
        while True:
            try:
                chunk = p.sock.recv(65536)
            except (ssl.SSLWantReadError, ssl.SSLWantWriteError, BlockingIOError, InterruptedError):
                break
            except OSError:
                return self.drop(p)
            if not chunk:
                return self.drop(p)
            p.buf += chunk
            if len(p.buf) > 1 << 20:
                return self.drop(p)
        p.last = time.monotonic()
        for fin, op, data in ws_parse(p.buf):
            if op == 0x8:
                return self.drop(p)
            if op == 0x9:
                self.write(p, ws_frame(data, 0xA))
            elif op == 0x1 or (op == 0x0 and p.frag is not None):
                p.frag = (p.frag or b'') + data
                if fin:
                    msg, p.frag = p.frag, None
                    self.forward(p, msg)
            if p.sock not in self.peers:
                return

    def forward(self, p, data):
        room = self.rooms.get(p.code)
        if not room:
            return
        try:
            m = json.loads(data)
        except ValueError:
            return
        if not isinstance(m, dict):
            return
        if 'relay' in m:
            # Only the game may steer the relay (to let go of a phone); phones can't fake relay messages.
            if p.role == 'game' and m['relay'] == 'kick' and room['phone']:
                self.drop(room['phone'])
            return
        other = room['phone' if p.role == 'game' else 'game']
        if other:
            self.write(other, ws_frame(data))

    def send(self, p, m):
        self.write(p, ws_frame(json.dumps(m, separators=(',', ':'))))

    def write(self, p, data):
        try:
            p.sock.settimeout(3)       # frames are tiny: a short blocking send keeps TLS simple
            p.sock.sendall(data)
            p.sock.setblocking(False)
        except OSError:
            self.drop(p)


RELAY = None


def relay():
    global RELAY
    with LOCK:
        if RELAY is None:
            RELAY = Relay()
    return RELAY


# ---------- the web servers ----------
class Handler(http.server.SimpleHTTPRequestHandler):
    timeout = 300                      # let go of idle keep-alive connections

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def blocked(self):
        path = urllib.parse.unquote(self.path.split('?', 1)[0].split('#', 1)[0])
        parts = [p for p in path.replace('\\', '/').split('/') if p]
        return any(p.startswith('.') for p in parts) or path.lower().endswith(('.py', '.pyc', '.cmd', '.bat', '.pem', '.key'))

    def send_json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def lan_info(self):
        urls = STATE['urls']
        return {'phoneUrl': urls[0]['url'] if urls else None, 'urls': urls, 'problem': STATE['problem'],
                'relay': True, 'firewall': STATE['firewall'], 'seen': latest_contact()}

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path == '/lan.json':
            return self.send_json(self.lan_info())
        if path == '/link':
            return self.upgrade()
        if self.blocked():
            return self.send_error(404)
        if getattr(self.server, 'phone', False):
            if path == '/':
                self.send_response(302)          # phones want the racket page, not the whole game
                self.send_header('Location', '/controller.html' + (self.path[1:] if self.path.startswith('/?') else ''))
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            if path == '/controller.html':
                note_contact(self.client_address[0], 'page')
        super().do_GET()

    def do_HEAD(self):
        if self.blocked():
            return self.send_error(404)
        super().do_HEAD()

    def upgrade(self):
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        role, code = q.get('role', [''])[0], q.get('code', [''])[0].upper()
        key = self.headers.get('Sec-WebSocket-Key', '')
        ok = (self.headers.get('Upgrade', '').lower() == 'websocket' and key and role in ('game', 'phone')
              and re.fullmatch(r'[A-Z0-9]{5}', code) and (role == 'phone' or is_local(self.client_address[0])))
        if not ok:
            return self.send_error(400)
        self.protocol_version = 'HTTP/1.1'
        self.send_response(101, 'Switching Protocols')
        self.send_header('Upgrade', 'websocket')
        self.send_header('Connection', 'Upgrade')
        self.send_header('Sec-WebSocket-Accept', ws_accept(key))
        self.end_headers()
        self.wfile.flush()
        if role == 'phone':
            note_contact(self.client_address[0], 'link')
        self.connection.settimeout(None)
        relay().adopt(self.connection, role, code).wait()   # the relay thread owns the socket until it closes
        self.close_connection = True

    def list_directory(self, path):
        self.send_error(404)
        return None

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


class Server(http.server.ThreadingHTTPServer):
    # Windows lets a second server share a port that has SO_REUSEADDR, so two copies of play.cmd would split
    # the requests between them. Take the port for ourselves instead.
    allow_reuse_address = sys.platform != 'win32'
    phone = False

    def server_bind(self):
        if sys.platform == 'win32' and hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class PhoneServer(Server):
    """The https server for phones. Each connection's TLS handshake runs in its own thread, so a phone sitting on the
    certificate warning holds up nobody, a refused certificate is noted for the game screen, and a plain http://
    request (a hand-typed address) is sent on to https://."""
    phone = True
    ctx = None

    def finish_request(self, request, client_address):
        request.settimeout(20)
        try:
            first = request.recv(1, socket.MSG_PEEK)
        except OSError:
            return
        if not first:
            return
        if first != b'\x16':               # not a TLS hello
            return self.redirect(request)
        try:
            tls = self.ctx.wrap_socket(request, server_side=True)
        except (OSError, ValueError):
            note_contact(client_address[0], 'tls')
            return
        tls.settimeout(None)
        try:
            self.RequestHandlerClass(tls, client_address, self)
        finally:
            try:
                tls.close()
            except OSError:
                pass

    def redirect(self, sock):
        try:
            head = sock.recv(4096).decode('latin-1')
            path = (head.split(' ') + ['/', '/'])[1]
            host = re.search(r'^host:\s*([^\s:]+)', head, re.I | re.M)
            host = host.group(1) if host else (STATE['urls'][0]['ip'] if STATE['urls'] else 'localhost')
            where = f'https://{host}:{self.server_address[1]}{path if path.startswith("/") else "/"}'
            sock.sendall(f'HTTP/1.1 301 Moved Permanently\r\nLocation: {where}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'.encode())
        except OSError:
            pass


def already_running(port):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/lan.json', timeout=2) as r:
            return 'phoneUrl' in json.loads(r.read().decode())
    except (OSError, ValueError):
        return False


def main():
    global PC_PORT, PHONE_PORT
    sys.stdout.reconfigure(line_buffering=True)
    ap = argparse.ArgumentParser(description='Serve Palm Court locally.')
    ap.add_argument('--no-browser', action='store_true', help='do not open a browser window')
    ap.add_argument('--no-phone', action='store_true', help='skip the https server for phones')
    ap.add_argument('--port', type=int, default=8765, help='port for this PC (default 8765)')
    ap.add_argument('--phone-port', type=int, default=8766, help='https port for phones (default 8766)')
    ap.add_argument('--ip', help="the address phones should use, if the one picked automatically doesn't work")
    args = ap.parse_args()
    PC_PORT, PHONE_PORT = args.port, args.phone_port

    try:
        pc = Server(('127.0.0.1', PC_PORT), Handler)
    except OSError:
        if already_running(PC_PORT):
            print(f'Palm Court is already running in another window: http://localhost:{PC_PORT}')
            if not args.no_browser:
                webbrowser.open(f'http://localhost:{PC_PORT}')
        else:
            print(f'Port {PC_PORT} is in use by another program. Close it, or start with: play.cmd --port 8770')
        return 1
    threading.Thread(target=pc.serve_forever, daemon=True).start()
    print('Palm Court is running.')
    print(f'  On this PC:    http://localhost:{PC_PORT}')

    ips = []
    if not args.no_phone:
        ads = adapters()
        cands = choose_ips(ads, route_ip())
        STATE['own'] = {a['ip'] for a in ads if a.get('ip')}      # requests from this PC itself aren't a phone
        if args.ip:
            if not usable(args.ip):
                print(f'  --ip {args.ip} is not a usable IPv4 address.')
                return 1
            cands = [{'ip': args.ip, 'name': 'chosen with --ip'}] + [a for a in cands if a['ip'] != args.ip]
        ips = [a['ip'] for a in cands]
        STATE['own'] |= set(ips)
    certs = ensure_cert(ips) if ips else None
    phone = None
    if certs:
        try:
            phone = PhoneServer(('0.0.0.0', PHONE_PORT), Handler)
        except OSError:
            STATE['problem'] = 'port'
            print(f'  Phone racket:  port {PHONE_PORT} is in use by another program. Try: play.cmd --phone-port 8767')
    if phone:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=str(certs[0]), keyfile=str(certs[1]))
        phone.ctx = ctx
        STATE['urls'] = [{'url': f'https://{a["ip"]}:{PHONE_PORT}/', 'ip': a['ip'], 'name': a.get('name', '')} for a in cands]
        threading.Thread(target=phone.serve_forever, daemon=True).start()
        print(f'  Phone racket:  {STATE["urls"][0]["url"]}controller.html  ({cands[0].get("name") or "network"})')
        for u in STATE['urls'][1:]:
            print(f'     or maybe:   {u["url"]}controller.html  ({u["name"]})')
        print('  Scan the QR code on the game screen with your phone (same Wi-Fi as this PC).')
        print('  Your phone will warn that the connection is not private: that is expected, the page comes from')
        print('  this PC. Android: tap Advanced, then Proceed. iPhone: tap Show Details, then visit this website.')
        if sys.platform == 'win32':
            def firewall():
                fw = check_firewall(PHONE_PORT)
                STATE['firewall'] = fw
                cats = {n['category'] for n in fw['networks']}
                if fw['state'] == 'blocked':
                    print(firewall_advice(fw))
                elif fw['state'] == 'unknown' and 'Public' in cats:
                    print('  Your network is set to Public. If Windows asks about Python, tick Public networks too,'
                          ' or phones may be blocked.')
            threading.Thread(target=firewall, daemon=True).start()
    elif args.no_phone:
        STATE['problem'] = 'off'
        print('  Phone racket:  off (--no-phone).')
    elif not ips:
        STATE['problem'] = 'no-network'
        print('  Phone racket:  not available (this PC is not on a network).')
    elif not certs:
        STATE['problem'] = 'no-openssl' if not find_openssl() else 'cert'
        print('  Phone racket:  not available (no certificate: openssl was not found or failed).')
        print('                 Install Git for Windows (it includes openssl), or host the game on GitHub Pages.')

    if not args.no_browser:
        webbrowser.open(f'http://localhost:{PC_PORT}')
    print('\nClose this window to stop the game server.')
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
