# Page-wide input and finished-job import

Image files dropped anywhere in the document become pending fitting inputs and
open the upload view. PNG, JPEG, WebP and other browser-supported raster types
retain the existing image decoder/fitting flow. A file-drag overlay is purely
visual and clears on drop, leave, Escape, blur or drag end. GIA drops on the
conversion zone retain their dedicated handler; images dropped there route to
image input. Existing running jobs and cancellation are unaffected.

JSON/CSS/SVG files chosen in the picker, dropped anywhere, or pasted as plain
text load directly as completed jobs. Clipboard image files also work across
views. Ordinary text paste/drop inside form fields stays native. One serialized
import queue handles multiple files; invalid files report localized errors
without adding a partial job, and other files in the batch still load.

Supported data:

- Existing Export JSON: image_size, config, origin, mask and elements. Absolute
  centres are retained; relative-only shapes reconstruct centres from origin.
  Aliases circle/rect are normalized. Packed game colours, precise alpha,
  rotations, dimensions and asset IDs are retained. Legacy outline units infer
  pixel scale from primitive_size when pixel_per_unit is absent. Geometry is
  never fitted or count-truncated.
- The site's Export CSS: shaper-container and shaper-element.shaper-eN rules,
  layer ordering, solid backgrounds, ellipse radii, triangle clipping, opacity,
  rotations/translation origins and the known Gaussian radial profile.
- Basic SVG: rect, circle, ellipse, supported three/four-point polygons, nested
  transforms, viewBox mapping (default meet or none), solid colours and the
  site's Gaussian gradients. Transformations are converted into supported
  primitive geometry. Native rectangle SVG coordinates are rounded to 0.001px;
  rectangular polygon validation allows 0.002 source pixels of serialization
  error. Other quadrilaterals/shears cannot become a single rectangle. Triangles
  must match the existing single-asset triangle geometry.

Paths, text, images, rounded rectangles, arbitrary gradients, CSS outside the
export grammar and unsupported effects/group opacity are rejected explicitly.
SVG/CSS is parsed as data, never attached as live content. Scripts, external
images/styles, foreign content and animation are not executed or fetched.
Fractional CSS/SVG viewport dimensions round up to whole raster pixels; shape
coordinates themselves remain unrounded. Imported JSON relative positions keep
full geometry precision on re-export. The JSON export layout is unchanged.

An imported drawing is rendered locally to a safe PNG snapshot for the job
thumbnail and reprocess input. Imported jobs show a populated fitted thumbnail only; they have no genuine
Original comparison or source underlay. Thumbnails without a cached preview are
rendered from the active job's shapes, so switching results cannot retain another
job's thumbnail. Its elements remain editable with undo/redo and
feed the existing JSON, CSS, SVG, PNG, GIA, Lua and batch exporters. Imported
origins are restored when the job opens. Screen sizing works as for fitted jobs.
Native fitting checkpoints and native quality references are not claimed for
imported jobs. Reprocess is an explicit new fitting task based on the snapshot.

Validation: npm run test:imports runs the parser/render tests in a real browser.
npm run test:browser also covers file drops, paste, edit/undo, exports, no fitting
workers, invalid files, script rejection and desktop/narrow layouts. Import UI
text and errors are localized in all 15 languages.
