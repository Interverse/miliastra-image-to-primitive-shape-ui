"""Seed-aggregated evaluation of retained baseline/candidate fits.

Usage: python scripts/evaluate-importance.py <candidate> [--baseline NAME] [--set pilot|heldout|heldout2|heldout3|heldout4]
       [--report NAME] [--review]

Metrics use the stored working-resolution target.png and turbo.png:
- rmse: premultiplied RGB error over black and white backgrounds (as the benchmark).
- regionRmse / regionGrad: the same error, and Sobel gradient error of the white
  composite, restricted to evaluation-only regions (held-out set only).
- spill: mean output alpha where the target is fully transparent.
Gates are the proposed plan tolerances; they are reported, never assumed met.
Runs that failed (failed.json, e.g. the benchmark timeout) are listed and fail all gates.
--review writes blind, randomized A/B sheets; the key is stored separately.
"""
import argparse
import json
from pathlib import Path
import random
from statistics import mean, median

import numpy as np
from PIL import Image, ImageDraw

p = argparse.ArgumentParser()
p.add_argument('candidate')
p.add_argument('--baseline')
p.add_argument('--set', choices=['pilot', 'heldout', 'heldout2', 'heldout3', 'heldout4'], default='heldout2')
p.add_argument('--report')
p.add_argument('--review', action='store_true')
p.add_argument('--expected-manifest', type=Path, required=True,
               help='frozen benchmark manifest defining every required image/count/seed')
a = p.parse_args()
root = Path(__file__).resolve().parents[1]
base = root / 'reference/automatic-importance'
baseline = a.baseline or ('baseline' if a.set == 'pilot' else a.set + '-baseline')
fixtures = {}
# Held-out regions are tracked; private tuning-subset regions stay in ignored reference/.
regions_file = {'pilot': base / 'pilot-regions.json', 'heldout': root / 'tests/primeval/importance-heldout.json',
                'heldout2': root / 'tests/primeval/importance-heldout-2.json',
                'heldout3': root / 'tests/primeval/importance-heldout-3.json',
                'heldout4': root / 'tests/primeval/importance-heldout-4.json'}[a.set]
if regions_file.is_file():
    fixtures = {f['id']: f for f in json.loads(regions_file.read_text())['images']}


def load(path):
    return np.asarray(Image.open(path).convert('RGBA'), dtype=np.float64) / 255


def composite(image, background):
    return image[..., :3] * image[..., 3:] + background * (1 - image[..., 3:])


def sobel(gray):
    padded = np.pad(gray, 1, mode='edge')
    gx = (padded[:-2, 2:] + 2 * padded[1:-1, 2:] + padded[2:, 2:]) - (padded[:-2, :-2] + 2 * padded[1:-1, :-2] + padded[2:, :-2])
    gy = (padded[2:, :-2] + 2 * padded[2:, 1:-1] + padded[2:, 2:]) - (padded[:-2, :-2] + 2 * padded[:-2, 1:-1] + padded[:-2, 2:])
    return gx, gy


def metrics(folder, image_id):
    target, output = load(folder / 'target.png'), load(folder / 'turbo.png')
    h, w = target.shape[:2]
    errors = sum((composite(target, b) - composite(output, b)) ** 2 for b in (0.0, 1.0))  # per-pixel, per-channel
    clear = target[..., 3] == 0
    result = dict(rmse=float(255 * np.sqrt(errors.mean() / 2)), spill=float(output[..., 3][clear].mean()) if clear.any() else 0.0)
    regions = fixtures.get(image_id, {}).get('regions')
    if regions:
        white_t, white_o = composite(target, 1.0).mean(axis=2), composite(output, 1.0).mean(axis=2)
        (tx, ty), (ox, oy) = sobel(white_t), sobel(white_o)
        gradient = (tx - ox) ** 2 + (ty - oy) ** 2
        union = np.zeros((h, w), bool)
        per = {}
        for name, (x0, y0, x1, y1) in regions.items():
            mask = np.zeros((h, w), bool)
            mask[int(np.floor(y0 * h)):int(np.ceil(y1 * h)), int(np.floor(x0 * w)):int(np.ceil(x1 * w))] = True
            union |= mask
            per[name] = float(255 * np.sqrt(errors[mask].mean() / 2))
        result.update(regionRmse=float(255 * np.sqrt(errors[union].mean() / 2)),
                      regionGrad=float(255 * np.sqrt(gradient[union].mean())), regions=per)
    return result


failed = sorted(f'{side}/{path.parent.name}' for side in (a.candidate, baseline)
                for path in (base / side).glob('image-*/failed.json'))
expected_manifest = json.loads(a.expected_manifest.read_text())
if expected_manifest.get('set', a.set) != a.set:
    raise ValueError('Expected manifest belongs to another fixture set')
expected = {f"image-{r['image']}-{r['count']}-{expected_manifest['detail']}-{r['seed']}"
            for r in expected_manifest['runs']}
if not expected:
    raise ValueError('Expected manifest contains no runs')
incomplete = []
for name in sorted(expected):
    for side in (a.candidate, baseline):
        folder = base / side / name
        for filename in ('results.json', 'target.png', 'turbo.png'):
            if not (folder / filename).is_file():
                incomplete.append(f'{side}/{name}/{filename}')
    if not fixtures.get(int(name.split('-')[1]), {}).get('regions'):
        incomplete.append(f'{name}: missing annotations')
rows = {}
for candidate in sorted((base / a.candidate).glob('image-*/results.json')):
    if candidate.parent.name not in expected:
        continue
    reference = base / baseline / candidate.parent.name
    if any(not (folder / file).is_file() for folder in (reference, candidate.parent)
           for file in ('results.json', 'target.png', 'turbo.png')):
        continue
    if (reference / 'target.png').read_bytes() != (candidate.parent / 'target.png').read_bytes():
        incomplete.append(f'{candidate.parent.name}: target mismatch')
        continue
    _, image_id, count, detail, seed = candidate.parent.name.split('-')
    key = (int(image_id), int(count), int(detail))
    rows.setdefault(key, []).append(dict(seed=int(seed), before=metrics(reference, key[0]), after=metrics(candidate.parent, key[0]),
                                         folders=(str(reference), str(candidate.parent))))

cases = []
for (image_id, count, detail), runs in sorted(rows.items()):
    agg = lambda side, k: mean(r[side][k] for r in runs)
    case = dict(image=image_id, count=count, detail=detail, seeds=sorted(r['seed'] for r in runs),
                category=fixtures.get(image_id, {}).get('category'),
                baselineRmse=agg('before', 'rmse'), candidateRmse=agg('after', 'rmse'),
                rmseChangePercent=100 * (agg('after', 'rmse') / agg('before', 'rmse') - 1),
                spillChange=agg('after', 'spill') - agg('before', 'spill'),
                perSeedRmseChangePercent=[100 * (r['after']['rmse'] / r['before']['rmse'] - 1) for r in runs],
                perSeedSpillChange=[r['after']['spill'] - r['before']['spill'] for r in runs])
    if 'regionRmse' in runs[0]['before']:
        case.update(regionRmseChangePercent=100 * (agg('after', 'regionRmse') / agg('before', 'regionRmse') - 1),
                    perSeedRegionRmseChangePercent=[100 * (r['after']['regionRmse'] / r['before']['regionRmse'] - 1) for r in runs],
                    regionGradChangePercent=100 * (agg('after', 'regionGrad') / agg('before', 'regionGrad') - 1),
                    perRegionChangePercent={name: 100 * (mean(r['after']['regions'][name] for r in runs) /
                                                         mean(r['before']['regions'][name] for r in runs) - 1)
                                            for name in runs[0]['before']['regions']})
        case['equalRegionChangePercent'] = mean(case['perRegionChangePercent'].values())
    case['worstSeedSpillChange'] = max(case['perSeedSpillChange'])
    case['worstSeedRmseChangePercent'] = max(case['perSeedRmseChangePercent'])
    case.update(globalGate=case['rmseChangePercent'] <= 2, spillGate=case['spillChange'] <= 0.0001)
    cases.append(case)

summary = []
for count, detail in sorted({(c['count'], c['detail']) for c in cases}):
    group = [c for c in cases if (c['count'], c['detail']) == (count, detail)]
    item = dict(count=count, detail=detail, images=len(group),
                medianRmseChangePercent=median(c['rmseChangePercent'] for c in group),
                improved=sum(c['rmseChangePercent'] < 0 for c in group),
                failedGlobal=[c['image'] for c in group if not c['globalGate']],
                failedSpill=[c['image'] for c in group if not c['spillGate']])
    regional = [c for c in group if 'regionRmseChangePercent' in c]
    if regional:
        categories = {}
        for c in regional:
            categories.setdefault(c['category'], []).append(c['regionRmseChangePercent'])
        item.update(medianRegionRmseChangePercent=median(c['regionRmseChangePercent'] for c in regional),
                    medianRegionGradChangePercent=median(c['regionGradChangePercent'] for c in regional),
                    categoryRegionMedians={k: median(v) for k, v in sorted(categories.items())})
        item['regionGate'] = item['medianRegionRmseChangePercent'] <= -5
        item['categoryGate'] = all(v <= 0 for v in item['categoryRegionMedians'].values())
    item['allGates'] = not failed and not incomplete and not item['failedGlobal'] and not item['failedSpill'] and item.get('regionGate', False) and item.get('categoryGate', False)
    summary.append(item)

report = dict(candidate=a.candidate, baseline=baseline, set=a.set, failedRuns=failed,
              incompleteRuns=incomplete, expectedRuns=len(expected), complete=not failed and not incomplete,
              summary=summary, cases=cases,
              note='Proposed gates, not established guarantees. Seed-aggregated means. Parallel-run timings are not speed evidence.')
name = a.report or f'evaluation-{a.candidate}'
(base / f'{name}.json').write_text(json.dumps(report, indent=2))
print(json.dumps(summary, indent=2))
if failed:
    print(f'FAILED RUNS ({len(failed)}), all gates fail:', ' '.join(failed))
if incomplete:
    print(f'INCOMPLETE ({len(incomplete)}), all gates fail:', ' '.join(incomplete))
for c in cases:
    extra = f"  region {c['regionRmseChangePercent']:+.2f}%  grad {c['regionGradChangePercent']:+.2f}%" if 'regionRmseChangePercent' in c else ''
    print(f"img {c['image']:2d} {c['count']:5d}/{c['detail']} {str(c['category']):12s} rmse {c['rmseChangePercent']:+.2f}%  spill {c['spillChange']:+.6f}{extra}")

if a.review:
    # Blind pairs: equally scaled target | A | B with randomized order; key saved separately.
    folder = base / f'review-{a.candidate}'
    folder.mkdir(exist_ok=True)
    rng = random.Random(20261031)
    key = {}
    for (image_id, count, detail), runs in sorted(rows.items()):
        run = min(runs, key=lambda r: r['seed'])
        images = [Image.open(Path(run['folders'][0]) / 'target.png').convert('RGBA')]
        flip = rng.random() < 0.5
        pair = [run['folders'][1], run['folders'][0]] if flip else list(run['folders'])
        images += [Image.open(Path(f) / 'turbo.png').convert('RGBA') for f in pair]
        w, h = images[0].size
        sheet = Image.new('RGB', (3 * w + 8, h), (128, 128, 128))
        for i, im in enumerate(images):
            tile = Image.new('RGBA', (w, h), (200, 200, 200, 255))
            tile.alpha_composite(im)
            sheet.paste(tile.convert('RGB'), (i * (w + 4), 0))
        draw = ImageDraw.Draw(sheet)
        for x0, y0, x1, y1 in fixtures.get(image_id, {}).get('regions', {}).values():
            draw.rectangle([x0 * w, y0 * h, x1 * w, y1 * h], outline=(0, 255, 255))
        name = f'image-{image_id}-{count}-{detail}-{run["seed"]}.png'
        sheet.save(folder / name)
        # Magnified region crops in the same blind order, one row per region.
        rows_out = []
        for x0, y0, x1, y1 in fixtures.get(image_id, {}).get('regions', {}).values():
            box = (int(x0 * w), int(y0 * h), max(int(x0 * w) + 1, int(np.ceil(x1 * w))), max(int(y0 * h) + 1, int(np.ceil(y1 * h))))
            scale = 160 / (box[3] - box[1])
            size = (max(1, round((box[2] - box[0]) * scale)), 160)
            tiles = []
            for im in images:
                tile = Image.new('RGBA', im.size, (200, 200, 200, 255))
                tile.alpha_composite(im)
                tiles.append(tile.crop(box).resize(size, Image.NEAREST).convert('RGB'))
            rows_out.append(tiles)
        if rows_out:
            width = max(3 * r[0].width + 8 for r in rows_out)
            crops = Image.new('RGB', (width, 164 * len(rows_out)), (128, 128, 128))
            for j, r in enumerate(rows_out):
                for i, tile in enumerate(r):
                    crops.paste(tile, (i * (tile.width + 4), j * 164))
            crops.save(folder / name.replace('.png', '-regions.png'))
        key[name] = 'A=candidate,B=baseline' if flip else 'A=baseline,B=candidate'
    (base / f'review-key-{a.candidate}.json').write_text(json.dumps(key, indent=2))
    print('review sheets:', folder)

if failed or incomplete:
    raise SystemExit(2)
