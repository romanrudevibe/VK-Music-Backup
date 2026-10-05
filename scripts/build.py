from pathlib import Path
from zipfile import ZipFile,ZIP_DEFLATED
import json,shutil
root=Path(__file__).resolve().parents[1];source=root/'extension'
version=json.loads((source/'manifest.json').read_text())['version']
out=root/'releases';out.mkdir(exist_ok=True)
archive=out/f'vk-music-backup-{version}.zip'
with ZipFile(archive,'w',ZIP_DEFLATED) as z:
    for p in sorted(source.rglob('*')):
        if p.is_file() and not any(x in ('node_modules','tests','.DS_Store') for x in p.parts):
            z.write(p,Path('vk-music-backup')/p.relative_to(source))
with ZipFile(archive) as z:
    assert z.testzip() is None
shutil.copyfile(archive,out/'vk-music-backup.zip')
print(archive)
