"""Export pinned UNISAL static SALICON inference; outputs stay in reference/.

Requires torch, numpy, onnx, onnxruntime. No source images leave this machine.
"""
import argparse
import hashlib
import importlib
import json
from pathlib import Path
import subprocess
import sys
import time
import types

parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, default=Path('reference/automatic-importance/unisal'))
parser.add_argument('--output', type=Path, default=Path('reference/automatic-importance/unisal.onnx'))
args = parser.parse_args()
import numpy as np
import torch
import onnxruntime as ort

source = args.source.resolve()
# Avoid upstream __init__ importing its unrelated training/data dependencies.
package = types.ModuleType('unisal')
package.__path__ = [str(source / 'unisal')]
sys.modules['unisal'] = package
model_module = importlib.import_module('unisal.model')
folder = source / 'training_runs/pretrained_unisal'
config = json.loads((folder / 'UNISAL.json').read_text())
config['cnn_cfg']['pretrained'] = False  # Full checkpoint supplies these weights.
config['verbose'] = 0
model = model_module.UNISAL(**config).cpu().eval()
checkpoint = folder / 'weights_best.pth'
model.load_state_dict(torch.load(checkpoint, map_location='cpu', weights_only=True), strict=True)

class StaticAttention(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.model = model

    def forward(self, image):
        # Input: ImageNet-normalized RGB, letterboxed to 288x384. Output: density.
        return self.model(image.unsqueeze(1), source='SALICON', static=True).exp()[:, 0]

torch.set_num_threads(4)
wrapper = StaticAttention().eval()
torch.manual_seed(42)
example = torch.rand(1, 3, 288, 384)
args.output.parent.mkdir(parents=True, exist_ok=True)
with torch.no_grad():
    expected = wrapper(example).numpy()
    torch.onnx.export(wrapper, example, str(args.output), input_names=['image'],
                      output_names=['attention'], opset_version=17, dynamo=False)
options = ort.SessionOptions()
options.intra_op_num_threads = 4
start = time.perf_counter()
session = ort.InferenceSession(str(args.output), options, providers=['CPUExecutionProvider'])
load_ms = (time.perf_counter() - start) * 1000
times = []
for _ in range(4):
    start = time.perf_counter()
    actual = session.run(None, {'image': example.numpy()})[0]
    times.append((time.perf_counter() - start) * 1000)
error = float(np.max(np.abs(expected - actual)))
np.testing.assert_allclose(actual, expected, rtol=1e-3, atol=1e-7)
report = dict(model='UNISAL SALICON static', upstream='https://github.com/rdroste/unisal',
              revision=subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip(),
              checkpoint_sha256=hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
              onnx_sha256=hashlib.sha256(args.output.read_bytes()).hexdigest(),
              bytes=args.output.stat().st_size, input=[1,3,288,384], output=list(actual.shape),
              max_abs_error=error, load_ms=load_ms, inference_ms=times,
              torch=torch.__version__, onnxruntime=ort.__version__,
              license='Apache-2.0 repository; preserve upstream LICENSE and attribution before shipping')
args.output.with_suffix('.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
