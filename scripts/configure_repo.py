from pathlib import Path
import json, re, sys
root=Path(__file__).resolve().parents[1]
if len(sys.argv)!=2 or not re.fullmatch(r'https://github\.com/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+',sys.argv[1]):
    raise SystemExit('Укажи ссылку https://github.com/владелец/репозиторий')
url=sys.argv[1].rstrip('/')
(root/'project.json').write_text(json.dumps({'repository_url':url},indent=2)+'\n')
(root/'extension/product-config.js').write_text('export const repositoryURL='+json.dumps(url)+';\n')
(root/'website/static/config.json').write_text(json.dumps({'repository_url':url})+'\n')
print('Ссылка GitHub настроена. Пересобери архив: npm run build')
