"""Minimal, dependency-light pure-Python PNG writer used to synthesize an exotic
test corpus (palette, low bit depths, gray+alpha, tRNS, Adam7 interlace, and every
filter type) that cv2.imencode cannot produce. Correctness of this writer is not
assumed: the golden pixels are always taken from cv2.imdecode of the bytes we emit,
so if this writer had a bug the JS decoder would simply be validated against cv2's
reading of a slightly-different-but-still-valid PNG.

Only the encoder features actually exercised by the corpus are implemented.
"""
import struct
import zlib

PNG_SIG = b"\x89PNG\r\n\x1a\n"

# Adam7 pass parameters: (x_start, y_start, x_step, y_step)
ADAM7 = [
    (0, 0, 8, 8),
    (4, 0, 8, 8),
    (0, 4, 4, 8),
    (2, 0, 4, 4),
    (0, 2, 2, 4),
    (1, 0, 2, 2),
    (0, 1, 1, 2),
]

CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


def _chunk(tag, data):
    out = struct.pack(">I", len(data)) + tag + data
    crc = zlib.crc32(tag + data) & 0xFFFFFFFF
    return out + struct.pack(">I", crc)


def _pack_scanline(samples, bit_depth):
    """Pack a flat list of integer samples (one row) MSB-first into bytes."""
    if bit_depth == 8:
        return bytes(samples)
    if bit_depth == 16:
        out = bytearray()
        for s in samples:
            out += struct.pack(">H", s)
        return bytes(out)
    # 1/2/4 bit: pack MSB first
    out = bytearray()
    acc = 0
    nbits = 0
    for s in samples:
        acc = (acc << bit_depth) | (s & ((1 << bit_depth) - 1))
        nbits += bit_depth
        while nbits >= 8:
            nbits -= 8
            out.append((acc >> nbits) & 0xFF)
    if nbits:
        out.append((acc << (8 - nbits)) & 0xFF)
    return bytes(out)


def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def _filter_row(raw, prev, bpp, ftype):
    """Apply a single PNG filter type to a raw scanline (bytes)."""
    n = len(raw)
    out = bytearray(n)
    for i in range(n):
        a = raw[i - bpp] if i >= bpp else 0
        b = prev[i] if prev is not None else 0
        c = prev[i - bpp] if (prev is not None and i >= bpp) else 0
        x = raw[i]
        if ftype == 0:
            out[i] = x & 0xFF
        elif ftype == 1:
            out[i] = (x - a) & 0xFF
        elif ftype == 2:
            out[i] = (x - b) & 0xFF
        elif ftype == 3:
            out[i] = (x - ((a + b) >> 1)) & 0xFF
        elif ftype == 4:
            out[i] = (x - _paeth(a, b, c)) & 0xFF
    return bytes(out)


def _pass_rows(pixels, width, height, px, py, sx, sy):
    """Yield rows of samples for one Adam7 pass. pixels is a list-of-rows,
    each row a flat list of samples (channels interleaved)."""
    rows = []
    y = py
    while y < height:
        row = []
        x = px
        src = pixels[y]
        while x < width:
            row.append((x, src))
            x += sx
        rows.append((y, [c for (xx, src) in row for c in src[xx * _CH:xx * _CH + _CH]]))
        y += sy
    return rows


_CH = 1  # module-global set per write call (channels), simplifies pass extraction


def write_png(path, pixels, width, height, bit_depth, color_type,
              palette=None, trns=None, interlace=0, filter_type=0):
    """pixels: list of `height` rows; each row a flat list of `width*channels`
    integer samples in the color_type's native channel order
    (gray / rgb / palette-index / gray+alpha / rgba).
    filter_type: fixed 0..4, or 'cycle' to rotate through 0..4 per row."""
    global _CH
    channels = CHANNELS[color_type]
    _CH = channels
    bpp = max(1, (channels * bit_depth) // 8)

    def encode_scanlines(idat, rows_samples):
        prev = None
        for idx, samples in enumerate(rows_samples):
            raw = _pack_scanline(samples, bit_depth)
            if filter_type == "cycle":
                ft = idx % 5
            else:
                ft = filter_type
            if prev is None and ft in (2, 3, 4):
                # up/avg/paeth still valid with implicit zero prev row
                pass
            idat.append(bytes([ft]) + _filter_row(raw, prev, bpp, ft))
            prev = raw

    idat_parts = []
    if interlace == 0:
        rows_samples = pixels
        encode_scanlines(idat_parts, rows_samples)
    else:
        for (px, py, sx, sy) in ADAM7:
            pw = len(range(px, width, sx))
            ph = len(range(py, height, sy))
            if pw == 0 or ph == 0:
                continue
            rs = []
            for yy in range(py, height, sy):
                src = pixels[yy]
                row = []
                for xx in range(px, width, sx):
                    row.extend(src[xx * channels:xx * channels + channels])
                rs.append(row)
            encode_scanlines(idat_parts, rs)

    raw_idat = b"".join(idat_parts)
    compressed = zlib.compress(raw_idat, 6)

    out = bytearray(PNG_SIG)
    ihdr = struct.pack(">IIBBBBB", width, height, bit_depth, color_type, 0, 0, interlace)
    out += _chunk(b"IHDR", ihdr)
    if color_type == 3 and palette is not None:
        plte = bytearray()
        for (r, g, b) in palette:
            plte += bytes([r, g, b])
        out += _chunk(b"PLTE", bytes(plte))
    if trns is not None:
        out += _chunk(b"tRNS", trns)
    out += _chunk(b"IDAT", compressed)
    out += _chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(bytes(out))
