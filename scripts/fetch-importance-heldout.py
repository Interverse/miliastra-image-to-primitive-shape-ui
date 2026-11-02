"""Fetch and verify evaluation images listed in tests/primeval/importance-heldout.json
(round-1 held-out, round-2 tuning) and importance-heldout-2.json (round-2 held-out).

Images go to ignored reference/automatic-importance/<set>/images and are never shipped.
"""
import hashlib
import json
from pathlib import Path
import time
import urllib.request

root = Path(__file__).resolve().parents[1]
sets = {'heldout': 'importance-heldout.json', 'heldout2': 'importance-heldout-2.json',
        'heldout3': 'importance-heldout-3.json', 'heldout4': 'importance-heldout-4.json'}
for name, manifest in sets.items():
    folder = root / 'reference/automatic-importance' / name / 'images'
    folder.mkdir(parents=True, exist_ok=True)
    for image in json.loads((root / 'tests/primeval' / manifest).read_text())['images']:
        target = folder / image['file']
        if not target.is_file():
            request = urllib.request.Request(image['url'], headers={'User-Agent': 'Miliastra-toolbox-importance-eval/1.0'})
            target.write_bytes(urllib.request.urlopen(request, timeout=120).read())
            time.sleep(5)  # Wikimedia rate-limits rapid original downloads.
        if hashlib.sha256(target.read_bytes()).hexdigest() != image['sha256']:
            raise ValueError(f'{target}: SHA256 mismatch')
        print('OK', image['file'])
