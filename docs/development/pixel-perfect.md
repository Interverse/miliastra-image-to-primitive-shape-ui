# Pixel-perfect

`js/pixel-perfect.js` copies an image exactly with axis-aligned rectangles
(image 100001, kind 2 in animation frames). There is no fitting: the image sets
the control count, so the count, shape, PNG mode and Opacity controls are hidden
(`output_alpha` is always 1). `js/worker-pixel.js` runs still images;
`worker-animation.js` (`pixelFrame`) runs GIF/video frames.

## Automatic selection

`app.js` (`autoPixelMethod`) switches to Pixel-perfect while every queued input
would need fewer than `PixelPerfect.THRESHOLD` (1,000) controls as a
Pixel-perfect copy. An image with many visible pixels but few colour areas
qualifies (for example a flat background with small details).

- Counting runs off the page in one persistent `worker-pixel.js`
  (`cmd: "count"`), using `PixelPerfect.controls(rgba, w, h, limit)`. This is
  the same cover as the output, but it stops once the colour count or a cover
  reaches `limit`. Stills use `limit` = 1,000. A photo stops after its first
  1,000 colours, and 4K/1080p inputs finish in under 0.7 s.
- GIFs are decoded in the worker with `ImageDecoder`, as composited frames.
  The average per frame must stay under 1,000. Each frame's limit is the
  remaining budget, capped at 10,000. Counting stops as soon as the average
  can no longer stay under 1,000, or one frame alone needs 10,000. Frames up to
  2K take under 1 s each at that cap. Without `ImageDecoder` a GIF is not
  selected.
- Videos have no alpha. Only a video under 1,000 pixels per frame is selected,
  because then it certainly needs fewer controls.

Adding a larger input restores the method used before. A method chosen by hand
is kept until the queue is emptied.

## Control compression

Colours are painted as layers, bottom first, in drawing order:

- An opaque colour's rectangles may also cover opaque pixels of colours painted
  later, because those colours paint over them. A background or outline becomes
  one rectangle under the details.
- Fully transparent pixels are never covered.
- Partially transparent pixels are covered exactly once, by their own colour,
  because stacked translucent layers would blend.
- Each rectangle starts at the first unpainted pixel of its colour, or as far
  left as allowed, and takes the width/height that paints the most unpainted
  pixels of that colour. Growth stops at the colour's bounding box.

Three covers are compared, keeping the one with the fewest rectangles:
no overlap (colours in order of first appearance), layers by descending pixel
count, and layers by descending bounding-box area.

Examples from `tests/pixel/run_tests.js` (row runs = one rectangle per
same-colour horizontal run):

| Image | Row runs | Rectangles |
| --- | ---: | ---: |
| 32×32 fill with 1-pixel outline | 92 | 2 |
| 32×32 background with 36 dots | 104 | 37 |
| 16×16 checkerboard | 256 | 129 |
| 24×24 outlined sprite | 75 | 16 |
| 600×400 background with 120 dots | 630 | 121 |

A 300×200 image where every pixel has its own colour takes about 0.3 s and needs
one rectangle per colour. A layered cover is dropped once its scanning exceeds
64 visits per pixel, which can happen when one colour is scattered across a
photo. The no-overlap cover is always kept.

## Animation Lua

Pixel-perfect animations are exact, so their Lua export offers Load speed (the
script's `LOAD_SPEED`, default 10) instead of Compact, on the result page and
next to Download all (ZIP). Higher loads faster; lowering it avoids execution
timeout errors in the game. A 377-control GIF loaded fine in game at 10.

## Tests

- `node tests/pixel/run_tests.js`: exactness when drawn in order, translucent
  pixels covered once, compression counts, bounded control counts, geometry,
  ignored Opacity.
- `node tests/pixel/run-browser.cjs`: automatic selection, hidden controls,
  exact JSON rebuild, layer compression, GIA export, method restore, a GIF
  through the Lua playback oracle.
