"""Real-image attention parity between browser ONNX inference and PyTorch UNISAL.

Usage: python scripts/check-attention-parity.py <dump-folder>...
Dump folders come from `node scripts/benchmark-attention.cjs --dump <image> <folder>`.
Reports, per image:
- model: PyTorch on the browser's exact input tensor vs browser ORT output;
- preprocessing: browser letterbox (canvas resampling) vs Python letterbox (PIL
  Lanczos, upstream's interpolation), compared after the shared normalization;
- adapter: our letterbox vs upstream SALICON stretch-to-288x384 preprocessing.
Requires torch, numpy and Pillow; outputs stay under reference/.
"""
import importlib
import json
from pathlib import Path
import sys
import types

import numpy as np
from PIL import Image
import torch

root = Path(__file__).resolve().parents[1]
source = root / 'reference/automatic-importance/unisal'
package = types.ModuleType('unisal')
package.__path__ = [str(source / 'unisal')]
sys.modules['unisal'] = package
config = json.loads((source / 'training_runs/pretrained_unisal/UNISAL.json').read_text())
config['cnn_cfg']['pretrained'] = False
config['verbose'] = 0
model = importlib.import_module('unisal.model').UNISAL(**config).cpu().eval()
model.load_state_dict(torch.load(source / 'training_runs/pretrained_unisal/weights_best.pth', map_location='cpu', weights_only=True), strict=True)
W, H, MATTE = 384, 288, (128, 128, 128)
MEAN, STD = np.array([.485, .456, .406]), np.array([.229, .224, .225])


def infer(tensor):
    with torch.no_grad():
        return model(torch.from_numpy(tensor).float()[None, None], source='SALICON', static=True).exp().reshape(H, W).numpy()


def normalize(values, alpha):
    """Same robust visible-pixel normalization as js/importance-analysis.js."""
    visible = np.sort(values[alpha > 0])
    if not len(visible):
        return None
    low, high = visible[int((len(visible) - 1) * .02)], visible[int((len(visible) - 1) * .98)]
    if high - low <= 1e-12:
        return None
    return np.where(alpha > 0, np.clip((values - low) / (high - low), 0, 1), 0)


def to_tensor(image):
    return ((np.asarray(image, np.float64) / 255 - MEAN) / STD).transpose(2, 0, 1)


def compare(a, b):
    return dict(maxAbs=float(np.max(np.abs(a - b))), meanAbs=float(np.mean(np.abs(a - b))),
                pearson=float(np.corrcoef(a.ravel(), b.ravel())[0, 1]))


reports = []
for folder in map(Path, sys.argv[1:]):
    meta = json.loads((folder / 'meta.json').read_text())
    crop = meta['crop']
    tensor = np.fromfile(folder / 'tensor.f32', np.float32).reshape(3, H, W)
    browser_raw = np.fromfile(folder / 'raw.f32', np.float32).reshape(H, W)
    alpha = np.fromfile(folder / 'alpha.u8', np.uint8).reshape(crop['height'], crop['width'])
    browser = np.fromfile(folder / 'values.f32', np.float32).reshape(alpha.shape) if (folder / 'values.f32').exists() else None
    torch_raw = infer(tensor)
    report = dict(image=meta['source'], crop=crop,
                  model=dict(maxAbs=float(np.max(np.abs(torch_raw - browser_raw))),
                             maxRelative=float(np.max(np.abs(torch_raw - browser_raw)) / np.max(np.abs(torch_raw)))))
    rgba = Image.open(meta['source'])
    rgba.load()
    if rgba.mode in ('I;16', 'I;16B', 'I'):
        rgba = rgba.point(lambda v: v / 256)
    rgba = rgba.convert('RGBA')
    matte = Image.new('RGBA', rgba.size, MATTE + (255,))
    matte.alpha_composite(rgba)
    rgb = matte.convert('RGB')
    letterbox = Image.new('RGB', (W, H), MATTE)
    letterbox.paste(rgb.resize((crop['width'], crop['height']), Image.LANCZOS), (crop['x'], crop['y']))
    python_tensor = to_tensor(letterbox)
    report['tensor'] = dict(maxAbs=float(np.max(np.abs(python_tensor - tensor))), meanAbs=float(np.mean(np.abs(python_tensor - tensor))))
    python_raw = infer(python_tensor)[crop['y']:crop['y'] + crop['height'], crop['x']:crop['x'] + crop['width']]
    python_map = normalize(python_raw, alpha)
    if browser is not None and python_map is not None:
        report['preprocessing'] = compare(browser, python_map)
        stretched = infer(to_tensor(rgb.resize((W, H), Image.LANCZOS)))
        stretched = np.asarray(Image.fromarray(stretched).resize((crop['width'], crop['height']), Image.BILINEAR))
        stretch_map = normalize(stretched, alpha)
        if stretch_map is not None:
            report['adapterVsUpstreamStretch'] = compare(python_map, stretch_map)
    reports.append(report)
    print(json.dumps(report))
out = root / 'reference/automatic-importance/attention-parity.json'
out.write_text(json.dumps(dict(reports=reports, note='Model parity uses identical tensors. Preprocessing and adapter rows measure deliberate/implementation differences, not model error.'), indent=2))
