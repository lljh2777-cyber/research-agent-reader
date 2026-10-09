"""Decode the pinned requested images; rasterize PDF pages without editing sources."""
from pathlib import Path
import hashlib
import json
import re
import sys
import fitz

if fitz.VersionBind != '1.27.2.3':
    raise ValueError('Frozen image preparation requires PyMuPDF 1.27.2.3')
source_root, output_root = [Path(p).resolve() for p in sys.argv[1:3]]
repo = Path(__file__).resolve().parent.parent
if output_root == source_root or source_root in output_root.parents or output_root == repo or repo in output_root.parents or any((p / '.obsidian').exists() for p in [output_root, *output_root.parents]):
    raise ValueError('Visual output must be outside sources, repository and Vaults')
text = sys.stdin.read(131073)
if len(text) > 131072:
    raise ValueError('Visual request metadata too large')
requests = json.loads(text)
if not isinstance(requests, list) or len(requests) > 64:
    raise ValueError('Visual request limit exceeded')
results = []
for request in requests:
    relative = request['sourceFile']
    if not all(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,199}', part) and '..' not in part for part in relative.split('/')):
        raise ValueError('Invalid visual source path')
    target = source_root
    for part in relative.split('/'):
        target = target / part
        if target.is_symlink():
            raise ValueError('Visual source links are not supported')
    if target.stat().st_size > 32 * 1024 * 1024:
        raise ValueError('Visual source too large')
    source = target.read_bytes()
    if hashlib.sha256(source).hexdigest() != request['sourceSha256']:
        raise ValueError('Visual source changed')
    if request['kind'] == 'pdf-page':
        with fitz.open(stream=source, filetype='pdf') as pdf:
            number = request['page']
            if not isinstance(number, int) or not 1 <= number <= len(pdf):
                raise ValueError('Visual page invalid')
            page = pdf[number - 1]
            if page.rect.width * page.rect.height * 2.5 ** 2 > 40000000:
                raise ValueError('Visual pixel limit exceeded')
            pix = page.get_pixmap(matrix=fitz.Matrix(2.5, 2.5), alpha=False)
            data, extension, mime = pix.tobytes('png'), 'png', 'image/png'
            transform = {'renderer': 'PyMuPDF 1.27.2.3', 'dpi': 180, 'rotation': int(page.rotation), 'clip': 'full-page'}
    elif request['kind'] == 'image' and target.suffix.lower() in ['.png', '.jpg', '.jpeg']:
        pix = fitz.Pixmap(source)
        data = source
        extension = 'png' if target.suffix.lower() == '.png' else 'jpg'
        mime = 'image/png' if extension == 'png' else 'image/jpeg'
        transform = {'decoder': 'PyMuPDF 1.27.2.3', 'operation': 'original-bytes'}
    else:
        raise ValueError('Unsupported visual request')
    if pix.width > 16000 or pix.height > 16000 or pix.width * pix.height > 40000000 or len(data) > 16 * 1024 * 1024:
        raise ValueError('Visual output budget exceeded')
    digest = hashlib.sha256(data).hexdigest()
    name = digest + '.' + extension
    destination = output_root / name
    if destination.is_symlink():
        raise ValueError('Visual output links are not supported')
    if destination.exists():
        if destination.stat().st_size != len(data) or destination.read_bytes() != data:
            raise ValueError('Existing visual output changed')
    else:
        with destination.open('xb') as file:
            file.write(data)
    results.append({**request, 'file': 'images/' + name, 'sha256': digest, 'bytes': len(data), 'mime': mime, 'width': pix.width, 'height': pix.height, 'transform': transform})
print(json.dumps(results, ensure_ascii=False))
