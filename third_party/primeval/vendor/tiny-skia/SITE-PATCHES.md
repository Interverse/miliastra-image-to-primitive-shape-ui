# tiny-skia 0.12.0 local patch

Source: crates.io tiny-skia 0.12.0, https://github.com/linebender/tiny-skia.
Original BSD-3-Clause license is retained in LICENSE. Registry Cargo metadata
is retained except targets whose large example/test fixtures are not vendored.

`Mask::fill_path_coverage_cached` runs the original clipped AA scan converter
with a coverage-only blitter on a cleared mask. It bypasses generic white-over-
black color blending and reuses edge storage through `MaskRasterScratch`.

The optional direct super blitter accumulates the original four sub-row start,
interior and stop contributions into the cleared byte mask, preserving the
original overflow correction. Existing Mask::fill_path and other drawing APIs
retain the original RLE super blitter and color pipeline as independent oracles.
Path quantization, antialiasing settings, edge construction, clipping, sorting,
curve subdivision and scan walking remain unchanged. Core tests compare full
scanline lists to the original Mask/Pixmap pipelines.
