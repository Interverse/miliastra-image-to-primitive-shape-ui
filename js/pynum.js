/*
 * pynum.js — exact ports of CPython / NumPy numeric primitives that affect
 * output values in the original backend.
 *
 *   PyNum.round(x, ndigits)  — CPython round(float, ndigits): correctly
 *                              rounded decimal rounding, ties to even,
 *                              computed on the EXACT binary value of x.
 *   PyNum.roundInt(x)        — CPython round(float) -> int (ties to even).
 *   PyNum.rint(x)            — np.rint: round half to even, returns float.
 *   PyNum.pairwiseSum(arr)   — np.sum float64 pairwise summation (same
 *                              block structure as numpy's pairwise_sum).
 */
"use strict";

const PyNum = (() => {

  /* Exact round-half-even of x*10^ndigits using the exact binary expansion
   * of the double, then a correctly-rounded parse back to double. This is
   * bit-identical to CPython's double_round (dtoa mode 3 + strtod). */
  function round(x, ndigits) {
    if (!Number.isFinite(x)) return x;
    if (x === 0) return x; // preserves signed zero

    const neg = x < 0;
    const ax = neg ? -x : x;

    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, ax);
    const hi = dv.getUint32(0);
    const lo = dv.getUint32(4);
    const expBits = (hi >>> 20) & 0x7ff;
    let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
    let e;
    if (expBits === 0) {
      e = -1074; // subnormal
    } else {
      mant |= 1n << 52n;
      e = expBits - 1075;
    }

    // ax = mant * 2^e;  ax * 10^n = (mant * 5^n) * 2^(e+n)
    const num = mant * (5n ** BigInt(ndigits));
    const shift = e + ndigits;
    let q;
    if (shift >= 0) {
      q = num << BigInt(shift); // exactly an integer — no rounding needed
    } else {
      const d = 1n << BigInt(-shift);
      q = num / d;
      const r = num % d;
      const twice = r * 2n;
      if (twice > d || (twice === d && (q & 1n) === 1n)) q += 1n;
    }

    let v;
    if (ndigits <= 0) {
      v = parseFloat(q.toString() + (ndigits < 0 ? "0".repeat(-ndigits) : ""));
    } else {
      let s = q.toString();
      while (s.length <= ndigits) s = "0" + s;
      v = parseFloat(s.slice(0, s.length - ndigits) + "." + s.slice(s.length - ndigits));
    }
    return neg ? -v : v;
  }

  /* CPython round(x) -> int (ties to even). Result returned as JS number
   * (all pipeline uses are small). */
  function roundInt(x) {
    if (!Number.isFinite(x)) return x;
    const f = Math.floor(x);
    const diff = x - f;
    if (diff > 0.5) return f + 1;
    if (diff < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  }

  /* np.rint — IEEE round-to-nearest-even, float result. Exact because a
   * fractional part of exactly .5 is representable. Preserves the sign of
   * zero (rint(-0.4) === -0.0) like the IEEE operation. */
  function rint(x) {
    if (!Number.isFinite(x)) return x;
    const f = Math.floor(x);
    const diff = x - f;
    let r;
    if (diff > 0.5) r = f + 1;
    else if (diff < 0.5) r = f;
    else r = f % 2 === 0 ? f : f + 1;
    if (r === 0 && (x < 0 || Object.is(x, -0))) return -0;
    return r;
  }

  /* numpy float64 pairwise summation (npy_pairwise_sum): for n <= 8 a
   * specific unrolled order; for 8 < n <= 128 blocks of 8 with 8 partial
   * accumulators; above 128 recursive halving on a multiple-of-8 split. */
  function pairwiseSum(arr, offset, n) {
    if (offset === undefined) { offset = 0; n = arr.length; }
    if (n < 8) {
      let res = 0;
      for (let i = 0; i < n; i++) res += arr[offset + i];
      return res;
    }
    if (n <= 128) {
      let r0 = arr[offset], r1 = arr[offset + 1], r2 = arr[offset + 2], r3 = arr[offset + 3];
      let r4 = arr[offset + 4], r5 = arr[offset + 5], r6 = arr[offset + 6], r7 = arr[offset + 7];
      let i;
      for (i = 8; i < n - (n % 8); i += 8) {
        r0 += arr[offset + i];
        r1 += arr[offset + i + 1];
        r2 += arr[offset + i + 2];
        r3 += arr[offset + i + 3];
        r4 += arr[offset + i + 4];
        r5 += arr[offset + i + 5];
        r6 += arr[offset + i + 6];
        r7 += arr[offset + i + 7];
      }
      let res = ((r0 + r1) + (r2 + r3)) + ((r4 + r5) + (r6 + r7));
      for (; i < n; i++) res += arr[offset + i];
      return res;
    }
    let n2 = Math.floor(n / 2);
    n2 -= n2 % 8;
    return pairwiseSum(arr, offset, n2) + pairwiseSum(arr, offset + n2, n - n2);
  }

  /* Exact fused multiply-add: round(a*b + c) with a single rounding, as
   * hardware FMA does. numpy's small-matrix `@` (BLAS dgemm) accumulates
   * dot products with FMA on this reference platform, which differs from
   * separate multiply+add in the last ulp — replicate exactly via exact
   * integer arithmetic. Call sites are few (triangle vertices), so BigInt
   * cost is irrelevant. */
  const _fmaBuf = new DataView(new ArrayBuffer(8));

  function _decompose(x) {
    _fmaBuf.setFloat64(0, x);
    const hi = _fmaBuf.getUint32(0);
    const lo = _fmaBuf.getUint32(4);
    const sign = hi >>> 31 ? -1n : 1n;
    const expBits = (hi >>> 20) & 0x7ff;
    let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
    let e;
    if (expBits === 0) { e = -1074; } else { mant |= 1n << 52n; e = expBits - 1075; }
    return { m: sign * mant, e };
  }

  function _roundToDouble(num, exp) {
    if (num === 0n) return 0;
    const neg = num < 0n;
    let m = neg ? -num : num;
    const bits = m.toString(2).length;
    const shift = bits - 53;
    let e = exp + shift;
    let q;
    if (shift > 0) {
      const d = 1n << BigInt(shift);
      q = m >> BigInt(shift);
      const r = m & (d - 1n);
      const twice = r * 2n;
      if (twice > d || (twice === d && (q & 1n) === 1n)) {
        q += 1n;
        if (q.toString(2).length > 53) { q >>= 1n; e += 1; }
      }
    } else {
      q = m << BigInt(-shift);
    }
    const val = Number(q) * Math.pow(2, e);
    return neg ? -val : val;
  }

  function fma(a, b, c) {
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) {
      return a * b + c;
    }
    if (a === 0 || b === 0) return 0 + c; // avoid signed-zero BigInt subtleties
    const A = _decompose(a), B = _decompose(b);
    const pm = A.m * B.m;
    const pe = A.e + B.e;
    if (c === 0) return _roundToDouble(pm, pe);
    const C = _decompose(c);
    const eMin = Math.min(pe, C.e);
    const num = (pm << BigInt(pe - eMin)) + (C.m << BigInt(C.e - eMin));
    return _roundToDouble(num, eMin);
  }

  /* ── scipy.ndimage.gaussian_filter1d, bit-exact ──
   * The pipeline only ever uses sigma=5.0 (curvature smoothing) and
   * sigma=2.0 (5.0*0.4). Kernel values depend on np.exp SIMD tails, so the
   * exact reference-kernel bits are embedded rather than recomputed.
   * The correlation loop is the NI_Correlate1D symmetric path: center term
   * first, then folded pairs (left+right)*w accumulated from the OUTERMOST
   * tap inward, with 'reflect' boundary extension. */
  const _GK_BITS = {
    "5": "3efc113e67a34f9a,3f0e9d347af7ba2c,3f200a91aed84201,3f3026ceaaef5d9c,3f3f3ffe5366298d,3f4d0bb4c23b8d53,3f59f03a798bae24,3f664156b94ff939,3f7258a96c00a508,3f7d0fdc1a91a71b,3f861d971cc0d07e,3f902b6d98acd25a,3f96b7adf708e81b,3f9eaa58a4ba7225,3fa3e2acd55166da,3fa8c75f2fc165cb,3fadaa6517492b60,3fb10fd11517a7f6,3fb2db2f1c27e704,3fb405ae2f8a8257,3fb46d39dcd3d08c,3fb405ae2f8a8257,3fb2db2f1c27e704,3fb10fd11517a7f6,3fadaa6517492b60,3fa8c75f2fc165cb,3fa3e2acd55166da,3f9eaa58a4ba7225,3f96b7adf708e81b,3f902b6d98acd25a,3f861d971cc0d07e,3f7d0fdc1a91a71b,3f7258a96c00a508,3f664156b94ff939,3f59f03a798bae24,3f4d0bb4c23b8d53,3f3f3ffe5366298d,3f3026ceaaef5d9c,3f200a91aed84201,3f0e9d347af7ba2c,3efc113e67a34f9a",
    "2": "3f118aad19e4159b,3f3c98b8c5d0dda5,3f6227362b5fc92d,3f81f30504e20207,3f9ba4d4125ffd2a,3fb0941b71ceef37,3fbef9093fc46e5a,3fc68856f9ab1983,3fc98862a07ae7b4,3fc68856f9ab1983,3fbef9093fc46e5a,3fb0941b71ceef37,3f9ba4d4125ffd2a,3f81f30504e20207,3f6227362b5fc92d,3f3c98b8c5d0dda5,3f118aad19e4159b",
  };

  const _gkCache = {};
  function _bitsToF(hex) {
    _fmaBuf.setUint32(0, parseInt(hex.slice(0, 8), 16));
    _fmaBuf.setUint32(4, parseInt(hex.slice(8, 16), 16));
    return _fmaBuf.getFloat64(0);
  }

  function _gaussianKernel(sigma) {
    const key = String(sigma);
    if (_gkCache[key]) return _gkCache[key];
    let kernel;
    if (_GK_BITS[key]) {
      kernel = Float64Array.from(_GK_BITS[key].split(",").map(_bitsToF));
    } else {
      // generic fallback (unused by the pipeline; Math.exp tails may differ
      // from np.exp for non-reference sigmas)
      const lw = Math.trunc(4.0 * sigma + 0.5);
      const phi = new Float64Array(2 * lw + 1);
      for (let i = -lw; i <= lw; i++) {
        phi[i + lw] = Math.exp(-0.5 / (sigma * sigma) * (i * i));
      }
      const total = pairwiseSum(phi);
      for (let i = 0; i < phi.length; i++) phi[i] = phi[i] / total;
      kernel = phi;
    }
    _gkCache[key] = kernel;
    return kernel;
  }

  function scipyGaussianFilter1d(arr, sigma) {
    const kernel = _gaussianKernel(sigma);
    const size1 = kernel.length >> 1;
    const n = arr.length;
    // reflect extension: (d c b a | a b c d | d c b a)
    const ext = new Float64Array(n + 2 * size1);
    for (let i = 0; i < n; i++) ext[size1 + i] = arr[i];
    for (let i = 0; i < size1; i++) {
      let idx = -1 - i;
      // reflect index into [0, n)
      while (idx < 0 || idx >= n) {
        if (idx < 0) idx = -idx - 1;
        if (idx >= n) idx = 2 * n - idx - 1;
      }
      ext[size1 - 1 - i] = arr[idx];
      let idx2 = n + i;
      while (idx2 < 0 || idx2 >= n) {
        if (idx2 < 0) idx2 = -idx2 - 1;
        if (idx2 >= n) idx2 = 2 * n - idx2 - 1;
      }
      ext[size1 + n + i] = arr[idx2];
    }
    // NI_Correlate1D symmetric loop
    const center = size1; // fw += size1; fw[0] is the center tap
    const out = new Float64Array(n);
    for (let ll = 0; ll < n; ll++) {
      const base = size1 + ll;
      let sum = ext[base] * kernel[center];
      for (let jj = -size1; jj < 0; jj++) {
        sum += (ext[base + jj] + ext[base - jj]) * kernel[center + jj];
      }
      out[ll] = sum;
    }
    return out;
  }

  return { round, roundInt, rint, pairwiseSum, fma, scipyGaussianFilter1d };
})();

if (typeof module !== "undefined") module.exports = PyNum;
