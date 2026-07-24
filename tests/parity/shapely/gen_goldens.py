"""
Golden generator for the Shapely (GEOS) parity of js/geometry.js.

Emits (into this directory):
  goldens.json      affine (ellipse/rect/circle) + area/length/interpolate +
                    intersection-routine goldens, each with the CPython cos/sin
                    bit values used, for trig injection in run_tests.js.
  simplify.json     TopologyPreservingSimplifier goldens for every qualifying
                    corpus contour (input open ring -> shapely simplified ring).
  decision_log.jsonl  instrumented real-pipeline run over the corpus: one record
                    per primitive candidate that reaches an intersection test,
                    carrying everything needed to replay the decision purely from
                    geometry (raw simplified ring id + shape params + ia/ea/score
                    + the chosen candidate per best_primitive_at invocation).

Run:  python tests/parity/shapely/gen_goldens.py
Then: node tests/parity/shapely/run_tests.js
"""
import os, sys, json, math, struct
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, ROOT)
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

import cv2
from shapely.geometry import Point, box, Polygon
from shapely.affinity import rotate, scale, translate
import final_shaper as fs

CORPUS = [os.path.join(ROOT, "demo", n) for n in
          ["demo.png", "demo2.png", "image.png", "image-1.png", "image2.png"]]


def bits(x):
    """IEEE754 double bit pattern as hex string (stable map key across langs)."""
    return struct.pack("<d", float(x)).hex()


def trig_pair(angle_deg):
    """Replicate shapely.affinity.rotate: a = angle*pi/180 (two ops); raw cos/sin."""
    a = angle_deg * math.pi / 180.0
    return {"argBits": bits(a), "cos": math.cos(a), "sin": math.sin(a)}


def mk_ellipse(cx, cy, rx, ry, ang):
    c = Point(0, 0).buffer(1.0, resolution=32)
    c = scale(c, rx, ry)
    c = rotate(c, ang, origin=(0, 0))
    return translate(c, cx, cy)


def mk_rect(cx, cy, w, h, ang):
    r = box(-w / 2, -h / 2, w / 2, h / 2)
    r = rotate(r, ang, origin=(0, 0))
    return translate(r, cx, cy)


def coords(poly):
    return [[float(x), float(y)] for x, y in poly.exterior.coords]


# ─────────────────────────── goldens.json ───────────────────────────
def gen_goldens():
    rng = np.random.default_rng(12345)
    g = {"ellipse": [], "rect": [], "circle": [], "area": [],
         "length": [], "interpolate": [], "intersection": []}

    # affine: ellipse / rect over a param grid incl. axis-aligned + oblique
    params = []
    for ang in [0, 30, 37, 45, 60, 90, 123, 180, -45, 12.34, 270]:
        params.append((rng.uniform(-50, 400), rng.uniform(-50, 400),
                       rng.uniform(1.5, 40), rng.uniform(1.5, 40), ang))
    for cx, cy, rx, ry, ang in params:
        ep = mk_ellipse(cx, cy, rx, ry, ang)
        g["ellipse"].append({"cx": cx, "cy": cy, "rx": rx, "ry": ry, "ang": ang,
                             "coords": coords(ep), "area": ep.area,
                             "length": ep.exterior.length, "trig": trig_pair(ang)})
        rp = mk_rect(cx, cy, rx * 2, ry * 2, ang)
        g["rect"].append({"cx": cx, "cy": cy, "w": rx * 2, "h": ry * 2, "ang": ang,
                          "coords": coords(rp), "area": rp.area, "trig": trig_pair(ang)})
    # base circle (default quad_segs=16)
    for _ in range(12):
        cx, cy, r = rng.uniform(0, 400), rng.uniform(0, 400), rng.uniform(1.5, 30)
        cp = Point(cx, cy).buffer(r)
        g["circle"].append({"cx": cx, "cy": cy, "r": r,
                            "coords": coords(cp), "area": cp.area})

    # area / length / interpolate on ellipse+rect boundaries (interpolate = 32 pts)
    for cx, cy, rx, ry, ang in params[:8]:
        ep = mk_ellipse(cx, cy, rx, ry, ang)
        b = ep.boundary
        total = b.length
        pts = [[b.interpolate(i / 32 * total).x, b.interpolate(i / 32 * total).y]
               for i in range(32)]
        g["length"].append({"kind": "ellipse", "cx": cx, "cy": cy, "rx": rx,
                            "ry": ry, "ang": ang, "length": total})
        g["interpolate"].append({"kind": "ellipse", "cx": cx, "cy": cy, "rx": rx,
                                "ry": ry, "ang": ang, "total": total, "pts": pts,
                                "trig": trig_pair(ang)})
        g["area"].append({"kind": "ellipse", "cx": cx, "cy": cy, "rx": rx,
                         "ry": ry, "ang": ang, "area": ep.area, "trig": trig_pair(ang)})
        rp = mk_rect(cx, cy, rx * 2, ry * 2, ang)
        rb = rp.boundary
        rtot = rb.length
        rpts = [[rb.interpolate(i / 32 * rtot).x, rb.interpolate(i / 32 * rtot).y]
                for i in range(32)]
        g["interpolate"].append({"kind": "rect", "cx": cx, "cy": cy, "w": rx * 2,
                                "h": ry * 2, "ang": ang, "total": rtot, "pts": rpts,
                                "trig": trig_pair(ang)})

    # intersection routine: random simple polygons + convex clips + the 3 real
    # self-touching corpus rings (validates buffer(0)-equivalent clip).
    subs = []
    for _ in range(60):
        k = rng.integers(4, 9)
        cx, cy = rng.uniform(50, 350), rng.uniform(50, 350)
        rads = rng.uniform(10, 60, size=k)
        ang0 = np.sort(rng.uniform(0, 2 * math.pi, size=k))
        poly = [[cx + rads[i] * math.cos(ang0[i]), cy + rads[i] * math.sin(ang0[i])]
                for i in range(k)]
        p = Polygon(poly)
        if p.is_valid and p.area > 1:
            subs.append(("rand", [[x, y] for x, y in p.exterior.coords]))
    for name, simp in _corpus_self_touching():
        subs.append((name, [[x, y] for x, y in simp.exterior.coords]))

    for tag, ring in subs:
        sp = Polygon(ring)
        subj = sp if sp.is_valid else sp.buffer(0)
        minx, miny, maxx, maxy = sp.bounds
        for _ in range(20):
            cx = rng.uniform(minx, maxx); cy = rng.uniform(miny, maxy)
            if rng.random() < 0.5:
                rx, ry, ang = rng.uniform(3, 40), rng.uniform(3, 40), rng.uniform(0, 180)
                B = mk_ellipse(cx, cy, rx, ry, ang)
                shape = {"kind": "ellipse", "cx": cx, "cy": cy, "a": rx, "b": ry, "ang": ang}
            else:
                w, h, ang = rng.uniform(4, 60), rng.uniform(4, 60), rng.uniform(0, 180)
                B = mk_rect(cx, cy, w, h, ang)
                shape = {"kind": "rect", "cx": cx, "cy": cy, "a": w, "b": h, "ang": ang}
            g["intersection"].append({"subjectRing": ring, "shape": shape,
                                      "area": subj.intersection(B).area,
                                      "trig": trig_pair(ang)})
    with open(os.path.join(HERE, "goldens.json"), "w") as f:
        json.dump(g, f)
    print("goldens.json:", {k: len(v) for k, v in g.items()})


def _iter_qualifying_contours():
    for path in CORPUS:
        img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
        if img is None:
            continue
        h, w = img.shape[:2]
        mask = fs.extract_mask(img)
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        mask = cv2.morphologyEx(cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k),
                                cv2.MORPH_OPEN, k)
        contours, _ = cv2.findContours(mask, cv2.RETR_TREE, cv2.CHAIN_APPROX_NONE)
        min_ca = max(100, w * h * 0.00005)
        for c in contours:
            if cv2.contourArea(c) < min_ca:
                continue
            x, y, cw, ch = cv2.boundingRect(c)
            if cw > w * 0.95 and ch > h * 0.95:
                continue
            mg = 5
            if (x + cw) < mg or x > (w - mg) or (y + ch) < mg or y > (h - mg):
                continue
            pts = c.reshape(-1, 2).astype(np.float64)
            if len(pts) < 3:
                continue
            yield os.path.basename(path), pts


def _corpus_self_touching():
    out = []
    for name, pts in _iter_qualifying_contours():
        simp = Polygon(pts).simplify(1.0, preserve_topology=True)
        if not simp.is_valid:
            out.append((name, simp))
    return out


# ─────────────────────────── simplify.json ──────────────────────────
def gen_simplify():
    recs = []
    for name, pts in _iter_qualifying_contours():
        simp = Polygon(pts).simplify(1.0, preserve_topology=True)
        recs.append({"name": name,
                     "input": [[float(x), float(y)] for x, y in pts],
                     "output": [[float(x), float(y)] for x, y in simp.exterior.coords],
                     "valid": bool(simp.is_valid),
                     "area": simp.area, "buffer0_area": simp.buffer(0).area})
    with open(os.path.join(HERE, "simplify.json"), "w") as f:
        json.dump(recs, f)
    print("simplify.json:", len(recs), "contours")


# ─────────────────── decision_log.jsonl (instrumented) ───────────────
_LOG = []
_RAW_RINGS = {}
_TRIG = {}
_ctx = {"contour": None, "call": 0}


def _reg_trig(angle_deg):
    a = angle_deg * math.pi / 180.0
    b = bits(a)
    if b not in _TRIG:
        _TRIG[b] = [math.cos(a), math.sin(a)]
    return b


def _instrumented_best_primitive_at(px, py, tangent, normal, dist_map, poly, cfg,
                                    kappa, seg_label):
    """Copy of final_shaper.best_primitive_at with per-candidate decision logging.

    Logs, for every candidate that goes through an intersection test, the shape
    params + ia + ea + score + the gate booleans + the scalars needed to replay
    the score purely from geometry, plus which candidate wins (argmax, first-max).
    """
    import math as _m
    ShapeType = fs.ShapeType
    rmin = cfg.min_size / 2
    rmax = cfg.max_size / 2
    best_r, center = fs.max_inscribed_radius(px, py, normal, dist_map, rmin, rmax)
    ang = _m.degrees(_m.atan2(tangent[1], tangent[0]))
    contain_t = 0.88 + cfg.precision * 0.10
    candidates = []
    # one compact record per invocation; shared header (cx,cy,ang,prec,argBits)
    # is stored once. cands: [kindCode, a, b, ia, ea, gate, dm, accepted]
    #   kindCode: 0 ellipse, 1 rect. bases: analytic base-candidate scores.
    inv = {"ct": _ctx["contour"], "cx": center[0], "cy": center[1], "ang": ang,
           "prec": cfg.precision, "rb": 0.0, "argBits": _reg_trig(ang),
           "bases": [], "cands": [], "chosen": -1}

    def push(cand, base_score=None):
        candidates.append(cand)
        if base_score is not None:
            inv["bases"].append(base_score)

    if cfg.allowed_types is None or ShapeType.ELLIPSE in cfg.allowed_types:
        cpoly = Point(center).buffer(best_r)
        push({'type': ShapeType.ELLIPSE, 'center': center, 'size': (best_r, best_r),
              'rot': ang, 'score': _m.pi * best_r ** 2, 'poly': cpoly, 'tr': best_r, 'sr': best_r},
             _m.pi * best_r ** 2)
    if cfg.allowed_types is None or ShapeType.RECTANGLE in cfg.allowed_types:
        bs = best_r * 1.6
        rpoly = fs.make_rect_poly(center[0], center[1], bs, bs, ang)
        if rpoly.is_valid:
            push({'type': ShapeType.RECTANGLE, 'center': center, 'size': (bs, bs),
                  'rot': ang, 'score': (bs * bs) * 0.9, 'poly': rpoly, 'tr': bs / 2, 'sr': bs / 2},
                 (bs * bs) * 0.9)

    if best_r >= cfg.min_radius_for_stretch:
        seg = fs.SEG_NAMES.get(seg_label, 'curved')
        kf = max(0.0, 1.0 - kappa * 30)
        if seg == 'straight':
            max_stretch = cfg.effective_aspect_limit + kf * 2; rect_bonus = cfg.rect_bonus + 1.5
        elif seg == 'curved':
            max_stretch = cfg.effective_aspect_limit + kf * 0.5; rect_bonus = cfg.rect_bonus * 0.5
        else:
            max_stretch = min(cfg.effective_aspect_limit, 2.0); rect_bonus = 0.0
        inv["rb"] = rect_bonus
        for asp in (1.3, 1.6, 2.0, 2.5, 3.0, 4.0, 5.0, max_stretch):
            if asp > max_stretch:
                continue
            mr = best_r * asp
            if cfg.allowed_types is None or ShapeType.ELLIPSE in cfg.allowed_types:
                try:
                    ep = fs.make_ellipse_poly(center[0], center[1], mr, best_r, ang)
                    if ep.is_valid:
                        ia = poly.intersection(ep).area; ea = ep.area
                        gate = ea > 0 and ia >= ea * contain_t
                        dm = fs.dist_map_containment_check(ep, dist_map) if gate else 0.0
                        dm_th = max(0.70, 0.88 - asp * 0.03)
                        acc = bool(gate and dm >= dm_th)
                        inv["cands"].append([0, mr, best_r, ia, ea, int(bool(gate)), dm, int(acc)])
                        if acc:
                            containment = ia / ea; compactness = best_r / mr
                            cp = 1.0 - cfg.precision * (1.0 - compactness) * 0.5
                            score = _m.pi * mr * best_r * containment ** 2 * cp
                            push({'type': ShapeType.ELLIPSE, 'center': center,
                                  'size': (mr, best_r), 'rot': ang, 'score': score,
                                  'poly': ep, 'tr': mr, 'sr': best_r})
                except Exception:
                    pass
            if cfg.allowed_types is None or ShapeType.RECTANGLE in cfg.allowed_types:
                rect_contain_t = max(0.86, contain_t - (1.0 - cfg.precision) * 0.06)
                try:
                    rw, rh = mr * 2, best_r * 2
                    rp = fs.make_rect_poly(center[0], center[1], rw, rh, ang)
                    if rp.is_valid:
                        ia = poly.intersection(rp).area; ra = rp.area
                        gate = ra > 0 and ia >= ra * rect_contain_t
                        dm = fs.dist_map_containment_check(rp, dist_map) if gate else 0.0
                        dm_th = max(0.65, 0.85 - asp * 0.04)
                        acc = bool(gate and dm >= dm_th)
                        inv["cands"].append([1, rw, rh, ia, ra, int(bool(gate)), dm, int(acc)])
                        if acc:
                            containment = ia / ra; compactness = rh / rw
                            cp = 1.0 - cfg.precision * (1.0 - compactness) * 0.5
                            score = rw * rh * (1.0 + rect_bonus) * containment ** 3 * cp
                            push({'type': ShapeType.RECTANGLE, 'center': center,
                                  'size': (rw, rh), 'rot': ang, 'score': score,
                                  'poly': rp, 'tr': rw / 2, 'sr': rh / 2})
                except Exception:
                    pass

    chosen = None
    if candidates:
        chosen = max(candidates, key=lambda c: c['score'])
        inv["chosen"] = candidates.index(chosen)
        _LOG.append(inv)
        return chosen
    return None


def gen_decision_log():
    # mirror shaper_core.process_image_outline's contour loop, with instrumentation
    orig = fs.best_primitive_at
    fs.best_primitive_at = _instrumented_best_primitive_at
    contour_uid = 0
    try:
        for path in CORPUS:
            img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
            if img is None:
                continue
            h, w = img.shape[:2]
            image_center = (w / 2.0, h / 2.0)
            primitive_size = max(3, min(200, 15))
            min_size = max(2, int(primitive_size * 0.4))
            max_size = max(min_size + 2, int(primitive_size * 2.0))
            mask = fs.extract_mask(img)
            k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
            mask = cv2.morphologyEx(cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k),
                                    cv2.MORPH_OPEN, k)
            dist_map = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
            contours, _ = cv2.findContours(mask, cv2.RETR_TREE, cv2.CHAIN_APPROX_NONE)
            cfg = fs.FittingConfig(min_size=min_size, max_size=max_size,
                                   spacing_ratio=0.9, precision=0.3)
            image_area = w * h
            min_ca = max(100, image_area * 0.00005)
            for c in contours:
                if cv2.contourArea(c) < min_ca:
                    continue
                x, y, cw, ch = cv2.boundingRect(c)
                if cw > w * 0.95 and ch > h * 0.95:
                    continue
                mg = 5
                if (x + cw) < mg or x > (w - mg) or (y + ch) < mg or y > (h - mg):
                    continue
                pts = c.reshape(-1, 2).astype(np.float64)
                if len(pts) < 3:
                    continue
                cuid = "%s#%d" % (os.path.basename(path), contour_uid)
                contour_uid += 1
                # raw simplified ring JS will reproduce (no buffer(0))
                simp = Polygon(pts).simplify(1.0, preserve_topology=True)
                _RAW_RINGS[cuid] = [[float(a), float(b)] for a, b in simp.exterior.coords]
                _ctx["contour"] = cuid
                # poly as final_shaper builds it (with buffer(0) repair)
                poly = simp
                if not poly.is_valid:
                    poly = poly.buffer(0)
                if not poly.is_valid or poly.area < cfg.min_size ** 2:
                    continue
                elements = fs.fit_beads(cuid, c, mask, dist_map, cfg, image_center)
                cum_arc, total_arc = fs.build_arc_length_index(pts)
                fs.fill_gaps(elements, cuid, pts, cum_arc, total_arc, poly,
                             dist_map, img.shape, cfg, image_center)
    finally:
        fs.best_primitive_at = orig

    # cap size ~10MB: keep records + referenced rings
    with open(os.path.join(HERE, "decision_log.jsonl"), "w") as f:
        f.write(json.dumps({"type": "rings", "rings": _RAW_RINGS}) + "\n")
        for r in _LOG:
            f.write(json.dumps(r) + "\n")
    sz = os.path.getsize(os.path.join(HERE, "decision_log.jsonl"))
    print("decision_log.jsonl:", len(_LOG), "candidate records,",
          len(_RAW_RINGS), "rings,", round(sz / 1e6, 2), "MB")


if __name__ == "__main__":
    gen_goldens()
    gen_simplify()
    gen_decision_log()
    print("done.")
