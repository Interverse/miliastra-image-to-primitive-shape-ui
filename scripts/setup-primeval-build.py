"""Download pinned public build tools into the ignored research build directory."""
from pathlib import Path
import urllib.request,zipfile
root=next(p for p in Path(__file__).resolve().parents if (p/'index.html').is_file() and (p/'js/app.js').is_file());b=root/'reference/research-2026-10/primeval-constrained';b.mkdir(parents=True,exist_ok=True)
def get(url,path):
 if not path.exists():path.write_bytes(urllib.request.urlopen(url,timeout=90).read())
get('https://raw.githubusercontent.com/domoarigatomrburato/primeval/41e3196b41f8a03b2e1d4bea726a9c5bd71db530/scripts/build-wasm.mjs',b/'upstream-build-wasm.mjs')
get('https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.129/wasm-bindgen-0.2.129-x86_64-pc-windows-msvc.tar.gz',b/'wasm-bindgen.tar.gz')
import tarfile
with tarfile.open(b/'wasm-bindgen.tar.gz') as z:z.extractall(b/'wasm-bindgen',filter='data')
print('Downloaded official wasm-bindgen 0.2.129 into',b/'wasm-bindgen')
