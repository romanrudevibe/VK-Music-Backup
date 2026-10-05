import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.request import Request, urlopen
from urllib.error import HTTPError

root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('vk_server',root/'website/server.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class StatisticsTests(unittest.TestCase):
    def test_atomic_counters_and_moscow_day_boundary(self):
        with tempfile.TemporaryDirectory() as d:
            moment=[datetime(2026,10,5,20,59,tzinfo=timezone.utc)]
            stats=module.Stats(Path(d)/'stats.sqlite',lambda:moment[0])
            with ThreadPoolExecutor(max_workers=8) as pool:
                list(pool.map(lambda _:stats.count('views'),range(40)))
            moment[0]=datetime(2026,10,5,21,0,tzinfo=timezone.utc)
            stats.count('views');stats.count('downloads')
            self.assertEqual(stats.rows(),[{'day':'2026-10-06','views':1,'downloads':1},{'day':'2026-10-05','views':40,'downloads':0}])
            self.assertEqual(module.Stats(Path(d)/'stats.sqlite').rows(),stats.rows())
    def test_http_counts_only_page_and_archive_get_and_protects_stats(self):
        with tempfile.TemporaryDirectory() as d:
            stats=module.Stats(Path(d)/'stats.sqlite')
            server=module.make_server(('127.0.0.1',0),stats,'test-password')
            thread=threading.Thread(target=server.serve_forever);thread.start()
            base='http://127.0.0.1:'+str(server.server_port)
            try:
                for path in ['/','/style.css','/download']:
                    with urlopen(base+path) as response:self.assertEqual(response.status,200)
                with urlopen(Request(base+'/',method='HEAD')):pass
                self.assertEqual(stats.rows()[0]['views'],1);self.assertEqual(stats.rows()[0]['downloads'],1)
                for path in ['/admin','/api/stats','/stats.csv']:
                    with self.assertRaises(HTTPError) as error:urlopen(base+path)
                    self.assertEqual(error.exception.code,401)
                auth='Basic '+base64.b64encode(b'admin:test-password').decode()
                with urlopen(Request(base+'/api/stats',headers={'Authorization':auth})) as response:
                    self.assertEqual(json.load(response)['days'],stats.rows())
                with urlopen(Request(base+'/stats.csv',headers={'Authorization':auth})) as response:
                    self.assertIn('day,views,downloads',response.read().decode('utf-8-sig'))
                for path in ['/../project.json','/data/stats.sqlite','/project.json']:
                    with self.assertRaises(HTTPError):urlopen(base+path)
            finally:server.shutdown();thread.join();server.server_close()

if __name__=='__main__':unittest.main()
