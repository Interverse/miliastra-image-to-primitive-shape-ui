"""Export official Real-ESRGAN animevideov3 weights to CPU-compatible ONNX."""
import pathlib,sys,hashlib,json
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'reference/ai-upscale/deps'))
import torch
from torch import nn
class Compact(nn.Module):
    def __init__(self):
        super().__init__(); layers=[nn.Conv2d(3,64,3,1,1),nn.PReLU(64)]
        for _ in range(16):layers.extend([nn.Conv2d(64,64,3,1,1),nn.PReLU(64)])
        layers.append(nn.Conv2d(64,48,3,1,1));self.body=nn.Sequential(*layers)
    def forward(self,x):
        return torch.nn.functional.pixel_shuffle(self.body(x),4)+torch.nn.functional.interpolate(x,scale_factor=4,mode='nearest')
p=ROOT/'reference/ai-upscale/realesr-animevideov3.pth'
model=Compact().eval();weights=torch.load(p,map_location='cpu',weights_only=True);model.load_state_dict(weights.get('params_ema',weights.get('params',weights)))
out=ROOT/'assets/models/realesr-animevideov3.onnx'
torch.onnx.export(model,torch.rand(1,3,64,64),str(out),input_names=['image'],output_names=['output'],dynamic_axes={'image':{2:'h',3:'w'},'output':{2:'oh',3:'ow'}},opset_version=17,dynamo=False)
import onnxruntime as ort,numpy as np
torch.set_num_threads(2);x=np.random.default_rng(42).random((1,3,24,24),dtype=np.float32)
actual=ort.InferenceSession(str(out),providers=['CPUExecutionProvider']).run(None,{'image':x})[0]
expected=model(torch.from_numpy(x)).detach().numpy();error=float(np.max(abs(actual-expected)));assert error<1e-4,error
(ROOT/'reference/ai-upscale/export.json').write_text(json.dumps({'source_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'onnx_sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'max_abs_error':error},indent=2));print(error)
