"""Golden generator for PyNum (CPython round / np.rint / np.sum pairwise)."""
import json
import os
import struct
import numpy as np

OUT = os.path.join(os.path.dirname(__file__), "goldens")
os.makedirs(OUT, exist_ok=True)

rng = np.random.default_rng(20260724)

def f2bits(x):
    return struct.pack(">d", float(x)).hex()

cases = []

# adversarial values around decimal ties for ndigits 2/4/6
for nd in (2, 4, 6):
    step = 10.0 ** (-nd)
    for base in (0.0, 1.0, -1.0, 12.0, -37.0, 1234.5, 1e6):
        for k in range(50):
            x = base + (k - 25) * step / 2.0  # lands on halves often
            cases.append((x, nd))
    # exact binary halves: n + 0.5*10^-nd representable-ish patterns
    for k in range(200):
        x = float(rng.integers(-10**6, 10**6)) * step + step / 2.0
        cases.append((x, nd))
# random doubles
for _ in range(3000):
    x = float(rng.normal(0, 10) * 10.0 ** float(rng.integers(-6, 7)))
    cases.append((x, int(rng.choice([2, 4, 6]))))
# round-to-int cases (alpha*255 pattern)
int_cases = []
for a in range(0, 256):
    for denom_alpha in (a / 255.0, a / 255.0 * 0.85, a / 255.0 * 0.5):
        int_cases.append(denom_alpha * 255.0)
for _ in range(2000):
    int_cases.append(float(rng.normal(0, 300)))
int_cases += [0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 254.5, 255.5]

round_golden = [
    {"x": f2bits(x), "nd": nd, "r": f2bits(round(float(x), nd))}
    for x, nd in cases
]
roundint_golden = [
    {"x": f2bits(x), "r": int(round(float(x)))}
    for x in int_cases
]
rint_golden = [
    {"x": f2bits(x), "r": f2bits(np.rint(np.float64(x)))}
    for x in int_cases
]

# pairwise sum: various lengths incl. block boundaries
sum_golden = []
for n in [1, 3, 7, 8, 9, 16, 100, 127, 128, 129, 200, 1000, 4096, 10001]:
    arr = rng.normal(0, 1, n) * (10.0 ** rng.integers(-3, 4, n))
    sum_golden.append({
        "arr": [f2bits(v) for v in arr],
        "r": f2bits(np.sum(arr)),
    })

with open(os.path.join(OUT, "pynum.json"), "w") as f:
    json.dump({
        "round": round_golden,
        "roundInt": roundint_golden,
        "rint": rint_golden,
        "pairwiseSum": sum_golden,
    }, f)
print(f"round={len(round_golden)} roundInt={len(roundint_golden)} rint={len(rint_golden)} sums={len(sum_golden)}")
