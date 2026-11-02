"""Inspect retained tuning maps against evaluation regions; never feeds fitting.

Uses legacy maps explicitly for historical diagnosis, not as a production cache.
"""
import json
from pathlib import Path
import numpy as np

root = Path(__file__).resolve().parents[1]
base = root / 'reference/automatic-importance'
fixtures = json.loads((root / 'tests/primeval/importance-heldout.json').read_text())['images']
rows = []
for fixture in fixtures:
    path = base / 'maps' / (fixture['sha256'] + '.json')
    if not path.is_file():
        raise FileNotFoundError(path)
    data = json.loads(path.read_text())
    values = np.array(data['values']).reshape(data['height'], data['width'])
    h, w = values.shape
    regions = {}
    for name, (x0, y0, x1, y1) in fixture['regions'].items():
        crop = values[int(y0*h):int(np.ceil(y1*h)), int(x0*w):int(np.ceil(x1*w))]
        regions[name] = {'meanAttention': float(crop.mean()),
                         'fractionAtLeastHalf': float((crop >= .5).mean())}
    rows.append({'image': fixture['file'], 'category': fixture['category'],
                 'map': str(path), 'regions': regions})
(base / 'attention-region-diagnosis.json').write_text(json.dumps(rows, indent=2))
for row in rows:
    print(row['image'], ', '.join(f"{name}: {v['meanAttention']:.2f}" for name, v in row['regions'].items()))
