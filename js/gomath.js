/* IIFE-wrapped: exports only via self.* / module.exports (avoids global lexical bindings clashing across importScripts). */
(() => {
/* ─────────────────────────────────────────────────────────────────────────
 * gomath.js — bit-exact ports of the Go standard library math functions used
 * by the fogleman/primitive fill algorithm (the GO-side of the pipeline).
 *
 * Go's math.Sin/Cos/Acos/Atan2/Pow are pure-Go (amd64 has assembly only for
 * Sqrt/Floor-class), and are NOT bit-identical to V8's Math.* on all inputs.
 * They are pure source, hence exactly portable. Ported from GOROOT/src/math/
 * {sin.go, asin.go, atan.go, atan2.go, pow.go}.
 *
 * Use these EVERYWHERE the Go code calls math.*; Math.sqrt is IEEE-defined and
 * safe to use directly. radians()/degrees() are kept as Go writes them:
 * two operations (d*Pi/180 and r*180/Pi) — do NOT fold into one constant.
 *
 * NOTE: only the |x| < reduceThreshold (1<<29) path of Sin/Cos is ported; the
 * Payne-Hanek reduction is never reached by this pipeline's angles (< a few
 * multiples of 2π). A guard throws if it ever is.
 *
 * Validated bit-exact (float64 bits) against a Go dump — see tests/parity/fill.
 * ───────────────────────────────────────────────────────────────────────── */
"use strict";

const PI = Math.PI; // Go math.Pi is the same float64 (nearest double to π)
const reduceThreshold = 1 << 29;

// Go compile-time constant `4/Pi` (exact π folded then rounded to float64).
// 0x3FF45F306DC9C883
const M_4_PI = (function () {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setBigUint64(0, 0x3ff45f306dc9c883n);
  return dv.getFloat64(0);
})();

const _sin = [
  1.58962301576546568060e-10,
  -2.50507477628578072866e-8,
  2.75573136213857245213e-6,
  -1.98412698295895385996e-4,
  8.33333333332211858878e-3,
  -1.66666666666666307295e-1,
];
const _cos = [
  -1.13585365213876817300e-11,
  2.08757008419747316778e-9,
  -2.75573141792967388112e-7,
  2.48015872888517045348e-5,
  -1.38888888888730564116e-3,
  4.16666666666665929218e-2,
];

const PI4A = 7.85398125648498535156e-1;
const PI4B = 3.77489470793079817668e-8;
const PI4C = 2.69515142907905952645e-15;

function cos(x) {
  if (Number.isNaN(x) || !Number.isFinite(x)) return NaN;
  let sign = false;
  x = Math.abs(x);
  if (x >= reduceThreshold) throw new Error("gomath.cos: trigReduce not ported (x too large)");
  let j = Math.trunc(x * M_4_PI); // uint64(x * (4/Pi))
  let y = j;
  if ((j & 1) === 1) { j++; y++; }
  j &= 7;
  let z = ((x - y * PI4A) - y * PI4B) - y * PI4C;
  if (j > 3) { j -= 4; sign = !sign; }
  if (j > 1) { sign = !sign; }
  const zz = z * z;
  let r;
  if (j === 1 || j === 2) {
    r = z + z * zz * ((((((_sin[0] * zz) + _sin[1]) * zz + _sin[2]) * zz + _sin[3]) * zz + _sin[4]) * zz + _sin[5]);
  } else {
    r = 1.0 - 0.5 * zz + zz * zz * ((((((_cos[0] * zz) + _cos[1]) * zz + _cos[2]) * zz + _cos[3]) * zz + _cos[4]) * zz + _cos[5]);
  }
  if (sign) r = -r;
  return r;
}

function sin(x) {
  if (x === 0 || Number.isNaN(x)) return x;
  if (!Number.isFinite(x)) return NaN;
  let sign = false;
  if (x < 0) { x = -x; sign = true; }
  if (x >= reduceThreshold) throw new Error("gomath.sin: trigReduce not ported (x too large)");
  let j = Math.trunc(x * M_4_PI);
  let y = j;
  if ((j & 1) === 1) { j++; y++; }
  j &= 7;
  let z = ((x - y * PI4A) - y * PI4B) - y * PI4C;
  if (j > 3) { sign = !sign; j -= 4; }
  const zz = z * z;
  let r;
  if (j === 1 || j === 2) {
    r = 1.0 - 0.5 * zz + zz * zz * ((((((_cos[0] * zz) + _cos[1]) * zz + _cos[2]) * zz + _cos[3]) * zz + _cos[4]) * zz + _cos[5]);
  } else {
    r = z + z * zz * ((((((_sin[0] * zz) + _sin[1]) * zz + _sin[2]) * zz + _sin[3]) * zz + _sin[4]) * zz + _sin[5]);
  }
  if (sign) r = -r;
  return r;
}

// ---- atan / asin / acos ----
function xatan(x) {
  const P0 = -8.750608600031904122785e-01;
  const P1 = -1.615753718733365076637e+01;
  const P2 = -7.500855792314704667340e+01;
  const P3 = -1.228866684490136173410e+02;
  const P4 = -6.485021904942025371773e+01;
  const Q0 = +2.485846490142306297962e+01;
  const Q1 = +1.650270098316988542046e+02;
  const Q2 = +4.328810604912902668951e+02;
  const Q3 = +4.853903996359136964868e+02;
  const Q4 = +1.945506571482613964425e+02;
  let z = x * x;
  z = z * ((((P0 * z + P1) * z + P2) * z + P3) * z + P4) / (((((z + Q0) * z + Q1) * z + Q2) * z + Q3) * z + Q4);
  z = x * z + x;
  return z;
}

function satan(x) {
  const Morebits = 6.123233995736765886130e-17;
  const Tan3pio8 = 2.41421356237309504880;
  if (x <= 0.66) return xatan(x);
  if (x > Tan3pio8) return PI / 2 - xatan(1 / x) + Morebits;
  return PI / 4 + xatan((x - 1) / (x + 1)) + 0.5 * Morebits;
}

function atan(x) {
  if (x === 0) return x;
  if (x > 0) return satan(x);
  return -satan(-x);
}

function asin(x) {
  if (x === 0) return x;
  let sign = false;
  if (x < 0) { x = -x; sign = true; }
  if (x > 1) return NaN;
  let temp = Math.sqrt(1 - x * x);
  if (x > 0.7) temp = PI / 2 - satan(temp / x);
  else temp = satan(x / temp);
  if (sign) temp = -temp;
  return temp;
}

function acos(x) {
  return PI / 2 - asin(x);
}

function signbit(x) {
  return (1 / x) < 0 || x < 0 || Object.is(x, -0);
}
function copysign(x, y) {
  return signbit(y) ? -Math.abs(x) : Math.abs(x);
}

function atan2(y, x) {
  if (Number.isNaN(y) || Number.isNaN(x)) return NaN;
  if (y === 0) {
    if (x >= 0 && !signbit(x)) return copysign(0, y);
    return copysign(PI, y);
  }
  if (x === 0) return copysign(PI / 2, y);
  if (!Number.isFinite(x)) {
    if (x === Infinity) {
      if (!Number.isFinite(y)) return copysign(PI / 4, y);
      return copysign(0, y);
    }
    if (!Number.isFinite(y)) return copysign(3 * PI / 4, y);
    return copysign(PI, y);
  }
  if (!Number.isFinite(y)) return copysign(PI / 2, y);
  const q = atan(y / x);
  if (x < 0) {
    if (q <= 0) return q + PI;
    return q - PI;
  }
  return q;
}

// ---- pow (with Frexp/Ldexp/Modf) ----
const _dv = new DataView(new ArrayBuffer(8));
function f64bits(f) { _dv.setFloat64(0, f); return _dv.getBigUint64(0); }
function bitsF64(b) { _dv.setBigUint64(0, BigInt.asUintN(64, b)); return _dv.getFloat64(0); }
const SHIFT = 52n, MASK = 0x7ffn, BIAS = 1023n;

function normalizeF(f) {
  const SmallestNormal = 2.2250738585072014e-308; // 2**-1022
  if (Math.abs(f) < SmallestNormal) return [f * 4503599627370496.0, -52]; // *2**52
  return [f, 0];
}
function frexp(f) {
  if (f === 0 || !Number.isFinite(f) || Number.isNaN(f)) return [f, 0];
  let e0;
  [f, e0] = normalizeF(f);
  let x = f64bits(f);
  let exp = e0 + Number((x >> SHIFT) & MASK) - Number(BIAS) + 1;
  x = x & ~(MASK << SHIFT);
  x = x | ((BIAS - 1n) << SHIFT);
  return [bitsF64(x), exp];
}
function ldexp(frac, exp) {
  if (frac === 0 || !Number.isFinite(frac) || Number.isNaN(frac)) return frac;
  let e0;
  [frac, e0] = normalizeF(frac);
  exp += e0;
  let x = f64bits(frac);
  exp += Number((x >> SHIFT) & MASK) - Number(BIAS);
  if (exp < -1075) return copysign(0, frac);
  if (exp > 1023) return frac < 0 ? -Infinity : Infinity;
  let m = 1;
  if (exp < -1022) { exp += 53; m = 1.0 / 9007199254740992.0; } // 2**-53
  x = x & ~(MASK << SHIFT);
  x = x | (BigInt(exp) + BIAS) << SHIFT;
  return m * bitsF64(x);
}
function modf(f) {
  if (f < 1) {
    if (f < 0) { const [i, fr] = modf(-f); return [-i, -fr]; }
    if (f === 0) return [f, f];
    return [0, f];
  }
  let x = f64bits(f);
  const e = Number((x >> SHIFT) & MASK) - Number(BIAS);
  if (e < 52) {
    x = x & ~((1n << BigInt(52 - e)) - 1n);
  }
  const int = bitsF64(x);
  return [int, f - int];
}
function isOddInt(x) {
  if (Math.abs(x) >= 9007199254740992.0) return false;
  const [xi, xf] = modf(x);
  return xf === 0 && (BigInt.asIntN(64, BigInt(xi)) & 1n) === 1n;
}
function pow(x, y) {
  // Fast, provably-identical path for the only exponent this pipeline uses:
  // Go's pow(x, 2) equals x*x (frexp-squaring yields the correctly-rounded x²,
  // which is exactly what a single IEEE multiply produces). Verified in tests.
  if (y === 2) return x * x;

  if (y === 0 || x === 1) return 1;
  if (y === 1) return x;
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  if (x === 0) {
    if (y < 0) return (signbit(x) && isOddInt(y)) ? -Infinity : Infinity;
    if (y > 0) return (signbit(x) && isOddInt(y)) ? x : 0;
  }
  if (!Number.isFinite(y)) {
    if (x === -1) return 1;
    if ((Math.abs(x) < 1) === (y === Infinity)) return 0;
    return Infinity;
  }
  if (!Number.isFinite(x)) {
    if (x === -Infinity) return pow(1 / x, -y);
    if (y < 0) return 0;
    if (y > 0) return Infinity;
  }
  if (y === 0.5) return Math.sqrt(x);
  if (y === -0.5) return 1 / Math.sqrt(x);

  let [yi, yf] = modf(Math.abs(y));
  if (yf !== 0 && x < 0) return NaN;
  if (yi >= 9223372036854775808.0) {
    if (x === -1) return 1;
    if ((Math.abs(x) < 1) === (y > 0)) return 0;
    return Infinity;
  }
  let a1 = 1.0, ae = 0;
  if (yf !== 0) {
    if (yf > 0.5) { yf--; yi++; }
    a1 = Math.exp(yf * Math.log(x));
  }
  let [x1, xe] = frexp(x);
  for (let i = BigInt(yi); i !== 0n; i >>= 1n) {
    if (xe < -4096 || 4096 < xe) { ae += xe; break; }
    if ((i & 1n) === 1n) { a1 *= x1; ae += xe; }
    x1 *= x1;
    xe <<= 1;
    if (x1 < 0.5) { x1 += x1; xe--; }
  }
  if (y < 0) { a1 = 1 / a1; ae = -ae; }
  return ldexp(a1, ae);
}

// radians()/degrees() exactly as Go writes them (two operations each).
function radians(d) { return d * PI / 180; }
function degrees(r) { return r * 180 / PI; }

const api = { sin, cos, acos, asin, atan, atan2, pow, radians, degrees, frexp, ldexp, modf, signbit, copysign, M_4_PI };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof self !== "undefined") self.GoMath = api;
})();
