"""Verify deployment fails before upload when Git omits a runtime module."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('pages', root / 'scripts/prepare-pages.py')
pages = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pages)


class DeploymentChecks(unittest.TestCase):
    def test_ignored_runtime_is_rejected(self):
        listing = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=root)
        omitted = b'js/vendor/primeval/dist/browser-runtime.js\0'
        self.assertIn(omitted, listing)
        with tempfile.TemporaryDirectory() as output, patch.object(pages.subprocess, 'check_output', return_value=listing.replace(omitted, b'')):
            with self.assertRaisesRegex(ValueError, 'Runtime file excluded from Git'):
                pages.assemble(Path(output))

    def test_broken_import_is_rejected(self):
        original = Path.read_text
        def read_text(path, *args, **kwargs):
            if path.name == 'browser-runtime.js':
                return 'import "./gone.js"; import("./missing.js");'
            return original(path, *args, **kwargs)
        with tempfile.TemporaryDirectory() as output, patch.object(Path, 'read_text', read_text):
            with self.assertRaisesRegex(ValueError, 'Missing deployed dependency'):
                pages.assemble(Path(output))


if __name__ == '__main__':
    unittest.main()
