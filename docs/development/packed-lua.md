# Packed client Lua exports

The Lua download chooses a self-contained packed v2 or v3 stream and a dedicated renderer.
`convertJsonToLuaText` retains the community converter layout and quantization.
JSON field names, structure and semantics are unchanged. Shapes retain their
order, geometry, colour, rotation and asset selection, including mixed Gaussian
and solid ellipses. No fitting result is simplified to save storage.

Each shape has eight integer columns: family, x/y, half-width/half-height,
rotation, ARGB colour, optional ellipse asset override (zero means default).
Each column chooses the smallest estimated representation: an offset and fixed
bit width, a palette of exact integers, or signed zigzag deltas. Constant columns
consume no stream bits. Row values are written least-significant bits first,
using six bits per character from A–Z, a–z, 0–9, hyphen and underscore. Padding
bits in the last character are zero. Column metadata is embedded beside DATA.
Unsafe integers fail explicitly; JS bitwise truncation is never used.

V3 additionally considers Rice coding for offset values and signed deltas. A
Rice parameter k writes floor(n / 2^k) one bits, a zero, then k remainder bits.
The encoder selects k by the actual total bit cost, so a large outlier does not
force every row to spend the same extra bits. Descriptor modes 0/1/2 remain raw,
delta and palette; 3/4 are offset Rice and delta Rice. Low offsets and palette
values retain exact integer arithmetic.

V3 can split ARGB into R, G−R, B−G and A, creating eleven columns (the first six
geometry fields, these four colour fields, and the asset override). The reader
reconstructs the original packed colour before rendering. Similar RGB channels,
small deltas and independently varying alpha can then use fewer bits. Both the
eight-column and eleven-column versions compete with the unchanged v2 encoder.
Selection compares actual stream, metadata and complete decoder lengths. V2 is
kept whenever the new representation would make the standalone script larger;
JSON and the existing quantization are untouched. Export now evaluates more
candidates on the client, trading some encoding work for smaller storage.

When beneficial, optional LZ references reduce repeated symbols. A reference is
`~` followed by two alphabet characters for distance and two for length, each
little-endian base 64. Distance is 1–4095 and length is 6–4095. Overlapping copies
are supported. Both the encoder search dictionary and Lua reader history retain
only a rolling window. This layer is selected only when it saves more than its
700-byte allowance for decoder overhead.

The renderer decodes one row at a time into a reusable table, retaining at most
a 4096-symbol history for LZ. It does not expand all shape tables or retain a Lua
table of native controls. The native UI hierarchy still contains all shapes.
Each independent script needs no require mapping, module or loader. The editable
WIDTH defaults to the exported source width rather than a hardcoded 600 pixels.
`buildReadableLuaScript` retains the general-purpose reference for parity tests,
using the same natural display size.

The transparent root image is the rectangular mask: static square asset 100001,
RGBA (255,255,255,0), enableMask=true, enableSoftEdge=false and
reverseMaskArea=false. Its size is WIDTH × (WIDTH × H / W), matching the exported
image and any selected device scale. The scaling canvas and every primitive are
inside this root, so clipping applies to the entire image. This reuses the
existing root and does not allocate additional game controls. For custom export
origins, the mask is positioned at the image bounds centre and the inner canvas
compensates that offset, preserving all shape positions while keeping the full
image inside the mask. JSON is unchanged.

Measured standalone UTF-8 sizes against the readable representation:

| Deterministic case | Readable | Packed | Original size retained |
| --- | ---: | ---: | ---: |
| 1,200 random mixed/Gaussian shapes | 68,368 | 21,311 | 31.2% |
| 1,800 patterned shapes, four colours | 79,988 | 3,593 | 4.5% |

A further deterministic 2,400-ellipse correlated-colour case decreases from
18,162 bytes with the previous v2 exporter to 11,906 bytes with v3 (34.4% less).
The two table cases retain v2 because v3 does not save space on them.

These synthetic measurements demonstrate data dependence, not a guarantee of a
20% ratio on every image. Tiny files have fixed renderer overhead, while diverse
geometry and colours have less redundancy. No new precision loss is introduced;
the existing 0.1-unit Lua quantizer remains in place.

The parity suite compares every recorded native rendering API call with the
readable export in native Lua (lua/texlua when available), including full 32-bit
colours, negative geometry, mixed assets, empty input, random data, Rice-coded geometry, reconstructed colour channels, and overlapping
LZ copies in both v2 and v3. Python converter parity also remains intact. Optional historical
fitting goldens are skipped if not generated. In-game loading remains a separate
validation step; host storage limits are not inferred from local tests.
