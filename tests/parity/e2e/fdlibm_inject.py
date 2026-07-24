"""Run the original Python pipeline against V8's (fdlibm) sin/cos/atan2.

Import this module BEFORE importing shaper_core/final_shaper/shapely — it
monkeypatches math.sin/cos/atan2 with lookup-table wrappers. Values are
resolved through Node (trig_eval.js) via a fixpoint: call `fixpoint(fn)`
which repeats `fn()` until no trig call misses the table.

Rationale: platform libms disagree with each other and with the JS engines'
fdlibm in the final bit on a few % of inputs (UCRT itself is only ~97%
correctly rounded). The original's output for near-tie orderings depends on
that choice, so the strict parity golden pins the SAME libm the port uses.
"""
import json
import math
import os
import struct
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))

_f2b = lambda x: struct.pack(">d", float(x)).hex()
_b2f = lambda h: struct.unpack(">d", bytes.fromhex(h))[0]

_TABLE = {"sin": {}, "cos": {}, "atan2": {}}
_MISSES = {"sin": set(), "cos": set(), "atan2": set()}
_real = {"sin": math.sin, "cos": math.cos, "atan2": math.atan2}


def _mk1(name):
    def f(x):
        key = _f2b(x)
        hit = _TABLE[name].get(key)
        if hit is not None:
            return _b2f(hit)
        _MISSES[name].add(key)
        return _real[name](x)
    return f


def _atan2(y, x):
    key = (_f2b(y), _f2b(x))
    hit = _TABLE["atan2"].get(key)
    if hit is not None:
        return _b2f(hit)
    _MISSES["atan2"].add(key)
    return _real["atan2"](y, x)


math.sin = _mk1("sin")
math.cos = _mk1("cos")
math.atan2 = _atan2


def resolve_misses():
    total = sum(len(v) for v in _MISSES.values())
    if total == 0:
        return 0
    req = {
        "sin": sorted(_MISSES["sin"]),
        "cos": sorted(_MISSES["cos"]),
        "atan2": sorted(_MISSES["atan2"]),
    }
    in_path = os.path.join(HERE, "_trig_req.json")
    out_path = os.path.join(HERE, "_trig_res.json")
    with open(in_path, "w") as f:
        json.dump(req, f)
    subprocess.run(["node", os.path.join(HERE, "trig_eval.js"), in_path, out_path],
                   check=True, shell=False)
    res = json.load(open(out_path))
    for i, key in enumerate(req["sin"]):
        _TABLE["sin"][key] = res["sin"][i]
    for i, key in enumerate(req["cos"]):
        _TABLE["cos"][key] = res["cos"][i]
    for i, key in enumerate(req["atan2"]):
        _TABLE["atan2"][tuple(key)] = res["atan2"][i]
    for s in _MISSES.values():
        s.clear()
    return total


def fixpoint(fn, max_iter=8):
    """Repeat fn() until every trig call hits the fdlibm table."""
    for _ in range(max_iter):
        result = fn()
        if resolve_misses() == 0:
            return result
    raise RuntimeError("fdlibm fixpoint did not converge")
