"""Retained, resumable baseline/guided matrix. Run without --run to freeze the manifest.

Outputs stay under ignored reference/automatic-importance/<out>/. Attention maps
depend only on the source image, so they are computed once per image and cached.
Fitting output does not depend on the thread count, so parallel jobs only affect
timing; timings from parallel runs are not isolated speed measurements.
A fit exceeding --timeout seconds (default 300) is killed and recorded as
failed.json; failed runs are reported, never silently dropped, and are skipped on
resume unless --retry-failed is given.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import math
from datetime import datetime, timezone

p = argparse.ArgumentParser()
p.add_argument('--run', action='store_true')
p.add_argument('--guided', action='store_true')
p.add_argument('--proposal-only', action='store_true')
p.add_argument('--prior', choices=['model', 'center', 'shifted', 'structure'], default='model',
               help='diagnostic controls; shifted moves the model map by half its width/height; '
                    'structure (with --proposal-only) proposes from structural weights and ignores the map')
p.add_argument('--set', choices=['pilot', 'heldout', 'heldout2', 'heldout3', 'heldout4'], default='pilot')
p.add_argument('--out', help='output folder name under reference/automatic-importance')
p.add_argument('--strength', type=float, default=0.5)
p.add_argument('--additive', type=float, default=0.0, help='attention-only weight term in [0, 4]')
p.add_argument('--refine', type=float, default=1.0, help='share of attention emphasis kept after shape search, [0, 1]')
p.add_argument('--gamma', type=float, default=1.0, help='map sharpening exponent applied to normalized attention')
p.add_argument('--detail', type=int, default=256)
p.add_argument('--counts', type=int, nargs='+', default=[400, 1000])
p.add_argument('--seeds', type=int, nargs='+', default=[42, 43, 44])
p.add_argument('--images', type=int, nargs='+', help='subset of image ids')
p.add_argument('--jobs', type=int, default=1)
p.add_argument('--threads', type=int, default=0, help='WASM threads per fit; 0 uses the worker default')
p.add_argument('--timeout', type=float, default=300, help='seconds before a fit is killed and failed')
p.add_argument('--retry-failed', action='store_true')
p.add_argument('--redistribution', choices=['energy', 'measured'], default='energy',
               help='Turbo redistribution ranking; measured is an opt-in experiment')
p.add_argument('--redistribution-trials', type=int, help='Turbo redistribution trials (engine default 8)')
p.add_argument('--rect-aspect', type=int, help='Turbo rectangle aspect cap (engine default 8)')
a = p.parse_args()
if a.prior == 'structure' and not (a.guided and a.proposal_only):
    raise ValueError('--prior structure requires --guided --proposal-only')
if not (0 <= a.strength <= 1 and 0 <= a.additive <= 4 and 0 <= a.refine <= 1 and a.gamma > 0):
    raise ValueError('strength and refine must be within [0, 1], additive within [0, 4]; gamma must be positive')
root = Path(__file__).resolve().parents[1]
base = root / 'reference/automatic-importance'
prefix = '' if a.set == 'pilot' else a.set + '-'
out = base / (a.out or (prefix + ('guided' if a.guided else 'baseline')))
out.mkdir(parents=True, exist_ok=True)
maps = base / 'maps'
maps.mkdir(exist_ok=True)
# A map's identity includes the implementation and model, not only its source.
map_inputs = [root / 'js/importance-analysis.js', root / 'scripts/benchmark-attention.cjs']
map_inputs += sorted(base.glob('*.onnx'))
map_version = hashlib.sha256(b''.join(f.read_bytes() for f in map_inputs)).hexdigest()

if a.set == 'pilot':
    downloads = Path.home() / 'Downloads'
    names = ['background-removed-image-standard (2).png', 'upscalemedia-transformed.png',
             'clorinde_transparent_by_taemuepuan_dh9x502-pre.png', 'Layla-min.png',
             'VoxEdit_WIN_latest (1)/data/ui/splash/splash0.png', 'lets-fucking-go.png',
             '1717129830651.jpg', '329de3fd172236b66058abdcfcd45836.jpg',
             '5f22029f1144fed8e94e6c3faa5fb2f2.jpg']
    sources = [dict(id=i + 1, path=downloads / name) for i, name in enumerate(names)]
else:
    # heldout became a tuning set in round 2; heldout2 is the untouched round-2 held-out set.
    manifest_name = {'heldout': 'importance-heldout.json', 'heldout2': 'importance-heldout-2.json',
                     'heldout3': 'importance-heldout-3.json', 'heldout4': 'importance-heldout-4.json'}[a.set]
    fixtures = json.loads((root / 'tests/primeval' / manifest_name).read_text())
    sources = [dict(id=f['id'], path=base / a.set / 'images' / f['file'], sha256=f['sha256'],
                    category=f['category']) for f in fixtures['images']]

manifest = {'created': datetime.now(timezone.utc).isoformat(), 'set': a.set, 'detail': a.detail,
            'revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
            'wasm': {v: hashlib.sha256((root / f'js/vendor/primeval/wasm/{v}/primeval_bg.wasm').read_bytes()).hexdigest()
                     for v in ('single', 'threaded')},
            'shape': 'mixed', 'profile': 'turbo', 'guided': a.guided,
            'strength': a.strength if a.guided else None, 'additive': a.additive if a.guided else None,
            'refine': a.refine if a.guided else None, 'gamma': a.gamma if a.guided else None, 'threads': a.threads or 'worker default',
            'proposalOnly': a.proposal_only, 'prior': a.prior, 'redistribution': a.redistribution, 'redistributionTrials': a.redistribution_trials, 'rectAspect': a.rect_aspect, 'jobs': a.jobs, 'timeoutSeconds': a.timeout, 'images': [], 'runs': []}
for source in sources:
    if a.images and source['id'] not in a.images:
        continue
    image = source['path']
    if not image.is_file():
        raise FileNotFoundError(image)
    digest = hashlib.sha256(image.read_bytes()).hexdigest()
    if source.get('sha256') and source['sha256'] != digest:
        raise ValueError(f'{image}: hash mismatch')
    manifest['images'].append({'id': source['id'], 'path': str(image), 'sha256': digest,
                               **({'category': source['category']} if 'category' in source else {})})
    for count in a.counts:
        for seed in a.seeds:
            destination = out / f'image-{source["id"]}-{count}-{a.detail}-{seed}'
            manifest['runs'].append({'image': source['id'], 'count': count, 'seed': seed,
                                     'directory': str(destination)})
# One manifest per invocation; earlier manifests in the same folder are kept.
stamp = manifest['created'].replace(':', '').replace('.', '')[:17]
(out / f'manifest-{a.detail}-{stamp}.json').write_text(json.dumps(manifest, indent=2))
images = {i['id']: i for i in manifest['images']}


def attention(image):
    """Cached normalized map for one source hash, computed in the browser pilot."""
    cached = maps / f'{image["sha256"]}-{map_version}.json'
    if not cached.is_file():
        subprocess.run(['node', 'scripts/benchmark-attention.cjs', image['path'], str(cached)],
                       cwd=root, check=True)
    return json.loads(cached.read_text())


def run(entry):
    destination = Path(entry['directory'])
    image = images[entry['image']]
    identity = dict(source=image['sha256'], mapVersion=map_version if a.guided else None,
                    wasm=manifest['wasm'], count=entry['count'], detail=a.detail, seed=entry['seed'],
                    guided=a.guided, strength=a.strength if a.guided else None,
                    additive=a.additive if a.guided else None, refine=a.refine if a.guided else None,
                    gamma=a.gamma if a.guided else None, proposalOnly=a.proposal_only, prior=a.prior)
    if a.redistribution != 'energy':  # default runs keep their earlier identity
        identity['redistribution'] = a.redistribution
    if a.redistribution_trials:
        identity['redistributionTrials'] = a.redistribution_trials
    if a.rect_aspect:
        identity['rectAspect'] = a.rect_aspect
    identity['runner'] = hashlib.sha256((root / 'scripts/benchmark-primeval-turbo.cjs').read_bytes()).hexdigest()
    provenance = destination / 'provenance.json'
    if (destination / 'results.json').is_file():
        if not provenance.is_file() or json.loads(provenance.read_text()) != identity:
            raise ValueError(f'{destination}: missing or changed provenance; use a new --out folder')
        return None
    failed = destination / 'failed.json'
    if failed.is_file() and not a.retry_failed:
        return destination.name
    destination.mkdir(parents=True, exist_ok=True)
    provenance.write_text(json.dumps(identity, indent=2))
    failed.unlink(missing_ok=True)
    env = dict(os.environ, PRIMEVAL_TURBO_PROFILES='turbo', PRIMEVAL_TURBO_SEED=str(entry['seed']))
    if a.threads:
        env['PRIMEVAL_THREADS'] = str(a.threads)
    if a.redistribution != 'energy':
        env['PRIMEVAL_REDISTRIBUTION'] = a.redistribution
    if a.redistribution_trials:
        env['PRIMEVAL_REDISTRIBUTION_TRIALS'] = str(a.redistribution_trials)
    if a.rect_aspect:
        env['PRIMEVAL_RECT_ASPECT'] = str(a.rect_aspect)
    image = images[entry['image']]
    if a.guided:
        map_file = destination / 'attention.json'
        source = attention(image)
        w, h = source['width'], source['height']
        if a.prior == 'center':
            source['values'] = [math.exp(-8 * (((x + .5) / w - .5)**2 + ((y + .5) / h - .5)**2))
                                for y in range(h) for x in range(w)]
        elif a.prior == 'shifted':
            original = source['values']
            source['values'] = [original[((y + h // 2) % h) * w + (x + w // 2) % w]
                                for y in range(h) for x in range(w)]
        values = source['values'] if a.gamma == 1 else [v ** a.gamma for v in source['values']]
        # Cached legacy maps may contain fitting options. Never inherit them:
        # explicit defaults must override previous experiments as well.
        map_file.write_text(json.dumps({'width': source['width'], 'height': source['height'],
                                        'values': values, 'strength': a.strength,
                                        'additive': a.additive, 'refine': a.refine, 'proposalOnly': a.proposal_only,
                                        **({'structuralProposals': True} if a.prior == 'structure' else {})}))
        env['PRIMEVAL_IMPORTANCE_MAP'] = str(map_file)
    start = time.monotonic()
    with (destination / 'run.log').open('w') as log:
        child = subprocess.Popen(['node', 'scripts/benchmark-primeval-turbo.cjs', image['path'],
                                  str(entry['count']), str(a.detail), str(destination)],
                                 cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            code, reason = child.wait(timeout=a.timeout), None
            if code:
                reason = f'exit code {code}'
        except subprocess.TimeoutExpired:
            # Kill the whole tree: the runner owns a headless browser.
            if os.name == 'nt':
                subprocess.run(['taskkill', '/T', '/F', '/PID', str(child.pid)], capture_output=True)
            child.kill()
            child.wait()
            reason = f'timeout after {a.timeout:g} s'
    if reason:
        (destination / 'results.json').unlink(missing_ok=True)
        failed.write_text(json.dumps({'reason': reason, 'seconds': round(time.monotonic() - start, 1)}))
        print(destination.name, 'FAILED', reason, flush=True)
        return destination.name
    print(destination.name, flush=True)
    return None


if a.run:
    if a.guided:
        for image in manifest['images']:
            attention(image)  # One inference at a time; the browser pilot is not shared.
    with ThreadPoolExecutor(max(1, a.jobs)) as pool:
        failures = [name for name in pool.map(run, manifest['runs']) if name]
    if failures:
        print(f'{len(failures)} failed runs:', ' '.join(failures), file=sys.stderr)
        sys.exit(1)
