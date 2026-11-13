/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/ (also LICENSES/mw_splat-MPL-2.0.txt).
 * Based on mw_splat by Golden_Water, commit 8c3951a. */
/* Splat band helper: computes loss and gradients for a range of image rows.
 * Started by worker-splat.js; one per thread. */
"use strict";
// The job worker usually starts this from a blob with splat-core.js inlined.
if (typeof SplatCore === "undefined") importScripts("splat-core.js?v=4");

let band = null, cap = 0, shared = null;

self.onmessage = ({ data }) => {
  try {
    if (data.cmd === "init") {
      const target = new Float64Array(data.target);
      band = SplatCore.createBand(target, data.width, data.height, data.weights ? new Float64Array(data.weights) : null, data.background);
      cap = data.cap;
      shared = data.params ? { params: new Float64Array(data.params), grads: new Float64Array(data.grads), index: data.index } : null;
      self.postMessage({ ready: true });
      return;
    }
    if (data.cmd !== "pass") return;
    if (shared) {
      const p = shared.params, n = p.length / SplatCore.STRIDE;
      const out = shared.grads.subarray(shared.index * n * SplatCore.STRIDE, (shared.index + 1) * n * SplatCore.STRIDE);
      out.fill(0);
      const { loss } = band.pass(p, n, cap, data.y0, data.y1, out);
      self.postMessage({ id: data.id, loss });
    } else {
      const p = new Float64Array(data.params), n = p.length / SplatCore.STRIDE;
      const { loss, grad } = band.pass(p, n, cap, data.y0, data.y1);
      const copy = grad.slice();
      self.postMessage({ id: data.id, loss, grad: copy.buffer }, [copy.buffer]);
    }
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error && error.stack || error) });
  }
};
