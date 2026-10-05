"""Download page with aggregate daily counters. Run behind an HTTPS reverse proxy."""
from contextlib import contextmanager
import argparse
import base64
import csv
import hmac
import io
import json
import os
from pathlib import Path
import sqlite3
from datetime import datetime
from zoneinfo import ZoneInfo
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]

class Stats:
    def __init__(self, path, clock=None):
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.clock = clock or (lambda: datetime.now(ZoneInfo('Europe/Moscow')))
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS daily(day TEXT PRIMARY KEY, views INTEGER NOT NULL DEFAULT 0, downloads INTEGER NOT NULL DEFAULT 0)')
    @contextmanager
    def connect(self):
        db=sqlite3.connect(self.path, timeout=15)
        try:
            with db: yield db
        finally: db.close()
    def count(self, kind):
        if kind not in ('views', 'downloads'):
            raise ValueError('Unknown counter')
        day = self.clock().astimezone(ZoneInfo('Europe/Moscow')).date().isoformat()
        with self.connect() as db:
            db.execute(f'INSERT INTO daily(day,{kind}) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET {kind}={kind}+1', (day,))
    def rows(self):
        with self.connect() as db:
            return [dict(zip(('day','views','downloads'), row)) for row in db.execute('SELECT day,views,downloads FROM daily ORDER BY day DESC')]

def make_server(address, stats, password, root=ROOT):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # No IP addresses, query strings or referers in application logs.
        def reply(self, status, body=b'', content_type='text/plain; charset=utf-8', headers=None):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'")
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            if self.command != 'HEAD':
                try: self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError): pass
        def authorized(self):
            if not password:
                return False
            expected = 'Basic '+base64.b64encode(('admin:'+password).encode()).decode()
            return hmac.compare_digest(self.headers.get('Authorization','').encode(), expected.encode())
        def do_HEAD(self):
            self.do_GET()
        def do_GET(self):
            path = urlsplit(self.path).path
            if path in ('/admin', '/admin/', '/api/stats', '/stats.csv'):
                if not self.authorized():
                    self.reply(401, b'Owner access only', headers={'WWW-Authenticate':'Basic realm="VK Music statistics", charset="UTF-8"'})
                    return
                if path == '/api/stats':
                    self.reply(200, json.dumps({'timezone':'Europe/Moscow','days':stats.rows()}).encode(), 'application/json')
                elif path == '/stats.csv':
                    out = io.StringIO(); writer = csv.DictWriter(out, fieldnames=('day','views','downloads'))
                    writer.writeheader();writer.writerows(stats.rows())
                    self.reply(200, ('\ufeff'+out.getvalue()).encode(), 'text/csv; charset=utf-8', {'Content-Disposition':'attachment; filename="vk-visits.csv"'})
                else:
                    self.reply(200, (root/'website/static/admin.html').read_bytes(), 'text/html; charset=utf-8')
                return
            if path in ('/', '/index.html'):
                if self.command == 'GET': stats.count('views')
                self.reply(200, (root/'website/static/index.html').read_bytes(), 'text/html; charset=utf-8')
                return
            if path == '/download':
                archive = root/'releases/vk-music-backup.zip'
                if not archive.exists(): self.reply(503, 'Архив ещё не собран.'.encode());return
                if self.command == 'GET': stats.count('downloads')
                self.reply(200, archive.read_bytes(), 'application/zip', {'Content-Disposition':'attachment; filename="vk-music-backup.zip"'})
                return
            allowed = {'/style.css':'text/css; charset=utf-8', '/admin.js':'text/javascript', '/landing.js':'text/javascript','/config.json':'application/json'}
            if path in allowed:
                self.reply(200, (root/'website/static'/path[1:]).read_bytes(), allowed[path]);return
            self.reply(404, b'Not found')
    return ThreadingHTTPServer(address, Handler)

if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--host',default='127.0.0.1');parser.add_argument('--port',type=int,default=8765)
    args=parser.parse_args()
    stats=Stats(os.environ.get('VK_STATS_DB',str(ROOT/'website/data/stats.sqlite')))
    password=os.environ.get('VK_STATS_PASSWORD','')
    if not password: print('Раздел статистики закрыт: задай VK_STATS_PASSWORD перед запуском.')
    server=make_server((args.host,args.port),stats,password)
    print(f'Страница скачивания: http://{args.host}:{args.port}')
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()
