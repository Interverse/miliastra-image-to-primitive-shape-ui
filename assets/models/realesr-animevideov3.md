# Real-ESRGAN anime video v3

Source checkpoint from https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-animevideov3.pth

Upstream project https://github.com/xinntao/Real-ESRGAN

BSD-3-Clause terms accompany this asset in `realesr-animevideov3-LICENSE.txt`.

Architecture is SRVGGNetCompact, 64 features, 16 internal convolutions, PReLU, 4× pixel shuffle with nearest residual. The browser downsamples its output to 2× using Canvas. RGB input/output are NCHW float32, range 0–1. Opset 17. Export tool is `scripts/export-upscaler.py`.

Checkpoint SHA256 `b8a8376811077954d82ca3fcf476f1ac3da3e8a68a4f4d71363008000a18b75d`.

ONNX SHA256 `b00938b82b7d18e8c0dd269e9ffc511294fa75faaac3c3de96ded962d4867620`.

PyTorch versus native ONNX CPU maximum absolute error was 0.000003666 on a seeded 24×24 tensor. Browser performance and perceptual effects depend on input and hardware.
