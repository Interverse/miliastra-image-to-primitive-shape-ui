# Editing, Lua templates and live previews

Selecting a primitive shows a rotated bounding box, four free-scale corner handles,
a side handle for each local X/Y axis,
a rotation handle above the box and a move handle at its center. Body dragging
retains multi-selection movement. Transform gestures create one undo entry and
invalidate native PNG/SVG caches; undo can restore the original native export.
Middle-button dragging pans without selecting or moving objects. The shape
selector changes the selected primitive between ellipse, rectangle and triangle,
preserving its bounding size, center, rotation, color and opacity. Shape changes
update export asset references and Lua template fields. Existing property controls remain available. Background controls are not editable
with gizmos. Pinching cancels the active transform gesture and navigates the view.

The full selection-box edges are draggable, not just their midpoint dots.
Left/right resize only local X; top/bottom resize only local Y, anchored at the
opposite edge. `js/gizmo-resize.js` owns rotated-edge hit testing and anchored
resize math. The visual box has a minimum screen size for thin primitives;
their actual dimensions are not inflated. Gizmo drawing and hit testing use
the same CSS-pixel scale, including high-DPI screens.

Primeval edits use the native WASM rasterizer through `worker-native-render.js`.
`native-edit.js` retains untouched native geometry and reconstructs edited asset
geometry in the original working coordinates. Rendering is coalesced while
dragging; the last native bitmap stays visible until a newer render completes.
Edited PNG/SVG exports await the corresponding native render. Undo restores the
original cached PNG/SVG. This avoids switching the whole drawing to Canvas 2D
antialiasing on the first drag. Gizmos remain a screen-only overlay.

Lua export uses one required Image Control Template index for all shapes, including
background controls. Each instance calls SetImage with StaticReference: circle
100002, rectangle 100001, triangle 100003, or Gaussian 106057. Gaussian instances
use Basic image mode; solid shapes use Stretch. The index is remembered locally
and shared with batch ZIP export; no per-family prompts are needed.

The generation preview above the queue follows the highlighted job card. Click
any job card, or focus it and press Enter/Space, to switch it; action buttons keep
their original behavior. There is no preview dropdown.

Primeval/Turbo stream each committed shape into an SVG layer cache on the main
thread. Browser rendering is coalesced to animation frames, without delaying
fitting. Checkpoint snapshots reconcile earlier changes; refinement sends layer
replacements plus actual completed-work counters. RGB joint optimization reports
iteration progress, while RGBA refinement reports layer operations across its
scheduled passes. The bar can finish early when the fitter converges. The final
preview uses final fitted pixels. Gaussian, Legacy and Outline retain their
existing raster/contour progress previews.

The opaque RGB reference used internally for transparent inputs sends progress
counts but no drawing or background. Only alpha-aware states are previewed over
a checkerboard; original alpha is never reapplied to a fitted image. Initial
transparent reference work may therefore show no image until RGBA fitting starts.

Preview notifications are throttled independently of fitting effort; no requested
steps or shapes are skipped. Renderer/binding changes require rebuilding both
browser WASM variants. Native SVG serialization does not change RNG/search.

Browser checks cover transform edits/undo, per-family Lua routing, intermediate
preview arrival, native output parity and desktop/narrow layouts. Keep unit,
alpha, Turbo, hosting and project-subpath deployment checks when changing this.

The lower-effort optimization is labeled Draft (stored profile `fastest`). A local
400-triangle, 128px VoxEdit comparison took 2.61s for Draft and 5.44s for Turbo;
PSNR was 28.09 versus 29.08 dB. This is a single diagnostic run, not a universal
speed claim, but establishes a useful speed/quality tradeoff for keeping Draft.
