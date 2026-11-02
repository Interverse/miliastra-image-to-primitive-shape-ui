"""Offline evaluator completeness regression; no browser or fitting required."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / 'reference/automatic-importance'


class Completeness(unittest.TestCase):
    def test_missing_run_and_target_mismatch(self):
        with tempfile.TemporaryDirectory(dir=BASE) as temporary:
            folder = Path(temporary)
            manifest = folder / 'manifest.json'
            manifest.write_text(json.dumps({'set': 'heldout', 'detail': 512,
                'runs': [{'image': 1, 'count': 400, 'seed': 42}]}))
            candidate, baseline = folder / 'candidate', folder / 'baseline'
            name = 'image-1-400-512-42'
            report = folder / 'report'
            command = [sys.executable, str(ROOT / 'scripts/evaluate-importance.py'),
                       str(candidate), '--baseline', str(baseline), '--set', 'heldout',
                       '--expected-manifest', str(manifest), '--report', str(report)]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertFalse(json.loads(report.with_suffix('.json').read_text())['complete'])
            for side, color in ((candidate, 'black'), (baseline, 'white')):
                run = side / name
                run.mkdir(parents=True)
                (run / 'results.json').write_text('{}')
                Image.new('RGB', (16, 16), color).save(run / 'target.png')
                Image.new('RGB', (16, 16), 'gray').save(run / 'turbo.png')
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2, result.stderr)
            data = json.loads(report.with_suffix('.json').read_text())
            self.assertFalse(data['complete'])
            self.assertIn('target mismatch', ' '.join(data['incompleteRuns']))


if __name__ == '__main__':
    unittest.main()
