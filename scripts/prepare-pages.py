"""Assemble the static site using only Git-tracked or non-ignored files.

Reject missing/ignored runtime dependencies before GitHub Pages upload. A local
ignored module must not make development tests pass while deployment breaks.
"""
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = ('index.html', 'coi-sw.js', 'css', 'js', 'assets', 'LICENSE', 'LICENSES')


def assemble(destination):
    eligible = set(subprocess.check_output(
        ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        cwd=ROOT).decode('utf-8').split('\0'))
    files = []
    for name in REQUIRED:
        source = ROOT / name
        if not source.exists():
            raise ValueError(f'Missing runtime path: {name}')
        for file in sorted(source.rglob('*')) if source.is_dir() else [source]:
            if file.is_file():
                relative = file.relative_to(ROOT).as_posix()
                if relative not in eligible:
                    raise ValueError(f'Runtime file excluded from Git: {relative}')
                files.append(file)
    available = {file.relative_to(ROOT).as_posix() for file in files}

    def dependency(file, value, document=False):
        url = urlsplit(value)
        if url.scheme or url.netloc or not url.path or '${' in value:
            return
        target = (ROOT if document or url.path.startswith('/') else file.parent) / unquote(url.path.lstrip('/'))
        try:
            relative = target.resolve().relative_to(ROOT).as_posix()
        except ValueError:
            raise ValueError(f'Dependency outside site: {file.name}: {value}')
        if relative not in available:
            raise ValueError(f'Missing deployed dependency in {file.relative_to(ROOT)}: {value}')

    for file in files:
        if file.suffix == '.html':
            for value in re.findall(r'(?:src|href)=["\']([^"\']+)["\']', file.read_text(encoding='utf-8')):
                dependency(file, value, document=True)
        elif file.suffix == '.js':
            text = file.read_text(encoding='utf-8')
            for value in re.findall(r'(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\bnew URL\(\s*)["\']([^"\']+)["\']', text):
                dependency(file, value)
            for args in re.findall(r'\bimportScripts\(([^)]*)\)', text):
                for value in re.findall(r'["\']([^"\']+)["\']', args):
                    dependency(file, value)
        elif file.suffix == '.css':
            for value in re.findall(r'url\(\s*["\']?([^\s)"\']+)', file.read_text(encoding='utf-8')):
                dependency(file, value)
    if destination.resolve() == ROOT:
        raise ValueError('Output directory cannot be the source root')
    if destination.exists():
        extras = {p.relative_to(destination).as_posix() for p in destination.rglob('*') if p.is_file()} - available - {'.nojekyll'}
        if extras:
            raise ValueError(f'Unexpected files in output; use a fresh directory: {sorted(extras)}')
    destination.mkdir(parents=True, exist_ok=True)
    for file in files:
        target = destination / file.relative_to(ROOT)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(file, target)
    (destination / '.nojekyll').touch()
    print(f'Prepared {len(files)} runtime files in {destination}')


if __name__ == '__main__':
    try:
        assemble(Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / '.pages-site')
    except (ValueError, OSError) as error:
        raise SystemExit(str(error))
