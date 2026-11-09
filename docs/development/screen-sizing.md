# Screen sizing before export

The result Export section opens a native modal dialog. The baselines are:
Keyboard/Mouse 1600×900, Mobile 1280×720, Controller 1920×1080, and Mobile
Controller 1280×720. Each device retains its own zoom and preview position. Untouched profiles start
with the same fraction of screen width; later edits are independent, including
Mobile and Mobile Controller. The currently selected device determines every
export scale. All four baselines remain 16:9, regardless of backdrop pixel size.
The user-supplied PC, mobile, controller and mobile-controller PNGs in
`assets/screen-backdrops/` fill the stage as visual references only; they never
enter exported image data or geometry.

Drag the preview to move it, use the corner/wheel or numeric width to scale it.
Snapping aligns moving edges or the scaled bounds with screen borders within
10 preview pixels; the checkbox disables it. Aspect ratio is preserved. Dialog
movement is preview-only: exports retain their existing origin. Cancel/Escape
leave the confirmed state untouched. Confirm stores the selected device, per-device normalized widths and preview
positions, and snap preference on the job, not in JSON or localStorage. Drafts
and retries copy all profiles independently; cancel cannot alter stored profiles.
Legacy single-size session objects are accepted without changing their export
scale and seed the initial device profiles.
Retries inherit that state; other image jobs remain independent.

Sync zoom is on by default for sessions without an explicit preference. Resizing
by corner, wheel, numeric width or Reset copies the current normalized width to
all device profiles while it is on. Checking it also syncs the current zoom once.
Sync current zoom copies that width once even with the checkbox off. Equal
normalized width means the same visual coverage, not identical pixel widths:
400px on PC corresponds to 320px on Mobile and 480px on Controller. Preview
positions remain independent. The checkbox and profile edits remain draft-only
until Confirm; Cancel/Escape restores every previously saved device zoom.

Natural game width is source pixel width / pixel_per_unit. Confirmed width is
normalized width × selected baseline width. Their ratio scales exported centres,
relative offsets, origin, shape dimensions, masks and GIA source bounds. Existing
JSON image_scale/unit_scale/pixel_per_unit fields are adjusted where present;
image_size remains the original source dimensions. No JSON keys are renamed or
removed, and no screen-session metadata enters the JSON. Exports never mutate
the fitted drawing, edit history, source alpha or pinned fitting data.

All GIA variants and batch GIA/JSON/Lua use the same export scale. Raster/vector
exports use the confirmed width / source pixel width; SVG changes its viewport
size while retaining its viewBox. PNG is rasterized from the fitted vector at the
confirmed dimensions (rounded to whole pixels). CSS scales its pixel dimensions
and offsets. Lua WIDTH defaults to the scaled natural size so it no longer
silently overrides the exported geometry with a 600px width.

Tests cover nonzero origins, mask alignment, JSON keys and input immutability,
all device baselines, individual downloads and per-image state. Browser checks
exercise native pointer resize/move, snapping on/off, cancel/reset, and dialog
layout/screenshots at desktop and narrow widths. UI text is localized in all
15 supported languages.
