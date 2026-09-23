# Client Control Template `.gia` suite

```bash
node tests/parity/gia-client/run_tests.js
```

No goldens and no Python: the suite runs off the three reference `.gia`
files supplied as the authoritative Client Control Templates — **`client_image_template.gia`**
(no parent image), **`client_mask_off_template.gia`** (image parent, mask
toggle off — the generation template) and **`client_mask_template.gia`**
(same object, toggle on) — all pinned by SHA-256 here. If any check fails, a
permanent regression fixture has been edited: restore the file rather than
re-pinning the hash.

What it verifies:

| Group | Checks |
|---|---|
| Reference fixture | Decodes to `Image Container` (container class 70) → `Square`, `Circle`; image IDs 100001/100002; parent links, sibling indices and the container's child/reference lists agree; **Circle is +100 X from Square** in the rect transform's anchored position; no Server-only components |
| Regeneration | The same scene through `GIA.MODE_CLIENT_IMAGE` yields an equivalent decoded structure (not byte-identical — GUIDs are regenerated and the editor stored 100.0 as 99.99993); the parent is renamed off `Image Container`; header, trailer, version, source path, container GUID and its info-slot set survive |
| Unknown data | Client-only components (slots 4, 63, 67, 74) are cloned byte-for-byte, compared with the object GUID masked out, using an independent protobuf reader (`protoscan.js`) |
| Server vs Client | Same logical scene through both serializers: identical image IDs, colours, positions, sizes, rotations, pivots and sibling indices; each keeps its own flavour's components; the client output validates; `toClassic` works on it. Case matrix: 1×1, small multicolour, transparency, 2000-element image, merged runs, square-only, circle-only, mixed IDs, rotations, fractional/negative offsets, non-ASCII group name, single element — plus every non-erroring `e2e/` golden result |
| Error parity | The `e2e/` cases where the original Python writer raises (`packed_color=None`) must raise identically in the Client path, not emit bytes |
| Compositing | Rasterises each overlap case three ways — source painter order, the Client child list painted in hierarchy order, and the Server child list painted in reverse — and requires all three to agree. Each case also asserts that *inverting* the client order breaks it, so a case with no real occlusion cannot silently pass |
| Parent image / mask toggle | The mask-off and mask-on references are the same object with the toggle flipped: container slots 1, 4, 63, 67 and 73 are byte-identical and only slot 74 differs, by exactly `501: 1`. Children are identical either way, proving masking adds nothing to the content. Generated output always carries the parent image (ID 100001, tint `0x00FFFFFF`, rect = source image bounds, toggle off), and flipping the toggle reproduces the mask-on reference |
| Parent geometry | Offset / very wide / overhanging / 150-child optimised / transparent / rotated / non-ASCII cases all assert `childOffset + parentOffset == sourceElementPosition` (parent transform applied exactly once) and that hierarchy order is unaffected |
| Parent safety | The parent is never merged into identical content, never dropped for looking redundant, never counted as content; a template without a parent image is refused |
| Validation | Rejects a Server template, a parent still named `Image Container`, a wrong container name and garbage bytes; catches a container with no parent image, a wrong parent rect, and either toggle state being wrong |

The Server side's byte-exactness against the original Python writer stays in
[`../e2e/run_gia_e2e.js`](../e2e/run_gia_e2e.js) — run both after touching
`js/gia.js`.

For interactive inspection use `node tools/gia-diff.js <a.gia> [b.gia]`, or
`node tools/gia-diff.js --masks` for the three-way report (client without
mask / supplied masked reference / freshly generated masked file).
