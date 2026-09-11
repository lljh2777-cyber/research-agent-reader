"""Reproduce pinned public CC BY sources outside the repo/Vault. No overwrites or cleanup.

Windows: D:\\python\\python.exe -X utf8 scripts/capture-reading-quality.py <new-source-root>
Requires PyMuPDF 1.27.2.3 only when creating pdf-text.json; does not install dependencies.
"""
from pathlib import Path
from urllib.request import build_opener, HTTPRedirectHandler
from urllib.parse import urlparse
import hashlib
import json
import re
import sys

REPO = Path(__file__).resolve().parent.parent


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def capture(root):
    root = Path(root).resolve()
    if root == REPO or REPO in root.parents or any((p / '.obsidian').exists() for p in [root, *root.parents]):
        raise ValueError('Source root must be outside the repository and Obsidian Vaults')
    spec = json.loads((REPO / 'tests/fixtures/reading-quality/r0-v1.json').read_text(encoding='utf-8'))
    opener = build_opener(NoRedirect())
    requests = 0
    for sample in spec['samples']:
        if not re.fullmatch(r'[a-z0-9-]+', sample['id']):
            raise ValueError('Invalid sample id')
        folder = root / sample['id']
        if folder.is_symlink():
            raise ValueError('Sample directory links are not allowed')
        folder.mkdir(parents=True, exist_ok=True)
        for item in sample['files']:
            name = item['path']
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,199}', name) or '..' in name or item['bytes'] > 32 * 1024 * 1024:
                raise ValueError('Invalid file contract')
            target = folder / name
            if target.is_symlink():
                raise ValueError('Source links are not allowed')
            if target.exists():
                if target.stat().st_size != item['bytes']:
                    raise ValueError('Existing source size differs: ' + str(target))
                data = target.read_bytes()
            elif name == 'pdf-text.json':
                import fitz
                if fitz.VersionBind != '1.27.2.3':
                    raise ValueError('Frozen PDF extractor requires PyMuPDF 1.27.2.3; found ' + fitz.VersionBind)
                source = folder / 'source.pdf'
                with fitz.open(source) as pdf:
                    pages = [{'page': i + 1, 'text': page.get_text()} for i, page in enumerate(pdf)]
                extracted = {'extractor': 'PyMuPDF ' + fitz.VersionBind, 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'pages': pages}
                # v1 was captured on Windows with CRLF JSON layout; embedded page text
                # is JSON-escaped and unchanged. Keep these bytes portable across OSes.
                data = json.dumps(extracted, ensure_ascii=False, indent=2).replace('\n', '\r\n').encode('utf-8')
            else:
                url = urlparse(item['url'])
                allowed = {'/metadata/' + sample['version'] + '.json'}
                if url.scheme != 'https' or url.netloc != 'pmc-oa-opendata.s3.amazonaws.com' or url.query or url.fragment or url.path not in allowed and not url.path.startswith('/' + sample['version'] + '/'):
                    raise ValueError('Source URL is not the pinned PMC version')
                with opener.open(item['url'], timeout=45) as response:
                    if response.status != 200:
                        raise ValueError('Non-200 response')
                    data = response.read(item['bytes'] + 1)
                requests += 1
            if len(data) != item['bytes'] or hashlib.sha256(data).hexdigest() != item['sha256']:
                raise ValueError('Frozen source hash mismatch; preserve old baseline: ' + str(target))
            if not target.exists():
                with target.open('xb') as output:
                    output.write(data)
        print(sample['id'] + ': pinned files verified', flush=True)
    print('SOURCE_CAPTURE_OK; network requests=' + str(requests))


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python capture-reading-quality.py <source-root-outside-repo-and-vault>')
    capture(sys.argv[1])
