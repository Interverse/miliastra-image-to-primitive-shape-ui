/* Independent browser implementation of the integral-image rectangle merging
 * described at https://github.com/wwh177/miliastra-image-algorithm.
 * No upstream source or its scan-order codec is bundled. RGBA is premultiplied.
 * Also supplies a budget-driven, best-first partition for comparison/fallback.
 */
"use strict";
const RectangleCompression = (() => {
  const pause = () => new Promise(resolve => setTimeout(resolve, 0));
  function prepare(rgba,width,height,transparent) {
    if(!(width>0&&height>0)||rgba.length!==width*height*4)throw Error("Invalid rectangle image dimensions");
    const out=new Float64Array(rgba.length);
    for(let p=0;p<rgba.length;p+=4){
      const a=rgba[p+3]/255;
      for(let c=0;c<3;c++)out[p+c]=rgba[p+c]/255*a+(transparent?0:1-a);
      out[p+3]=transparent?a:1;
    }
    return out;
  }
  class Integral {
    constructor(pixels, width, height, channels = 4) {
      this.width = width; this.height = height; this.stride = width + 1;
      this.channels = channels;
      this.sum = Array.from({length: channels}, () => new Float64Array((width + 1) * (height + 1)));
      this.square = this.sum.map(a => new Float64Array(a.length));
      // Match NumPy cumsum(0).cumsum(1), including the floating-point order
      // used by the native tolerance-map blur at classification boundaries.
      for (let c = 0; c < channels; c++) {
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const v = pixels[(y * width + x) * channels + c], i = (y + 1) * this.stride + x + 1;
          this.sum[c][i] = this.sum[c][i - this.stride] + v;
          this.square[c][i] = this.square[c][i - this.stride] + v*v;
        }
        for (let y = 1; y <= height; y++) for (let x = 1; x <= width; x++) {
          const i = y*this.stride+x;
          this.sum[c][i] += this.sum[c][i-1];this.square[c][i] += this.square[c][i-1];
        }
      }
    }
    rect(a, x, y, w, h) {
      const i = y * this.stride + x, j = i + h * this.stride;
      return a[j + w] - a[j] - a[i + w] + a[i];
    }
    stats(x, y, w, h) {
      const n = w * h, color = [], variance = [];
      let error = 0;
      for (let c = 0; c < this.channels; c++) {
        const s = this.rect(this.sum[c], x, y, w, h), q = this.rect(this.square[c], x, y, w, h);
        color.push(s / n); variance.push(Math.max(0, q / n - (s / n) ** 2));
        error += Math.max(0, q - s * s / n);
      }
      return {x, y, w, h, color, variance, error};
    }
  }

  // Max-heap: the next control always goes to the largest error reduction.
  class Heap {
    constructor() { this.items = []; }
    push(node) {
      const a = this.items; let i = a.length; a.push(node);
      while (i) { const p = (i - 1) >>> 1; if (a[p].gain >= node.gain) break; a[i] = a[p]; i = p; }
      a[i] = node;
    }
    pop() {
      const a = this.items, root = a[0], last = a.pop();
      if (a.length) {
        let i = 0;
        while (i * 2 + 1 < a.length) {
          let child = i * 2 + 1;
          if (child + 1 < a.length && a[child + 1].gain > a[child].gain) child++;
          if (a[child].gain <= last.gain) break;
          a[i] = a[child]; i = child;
        }
        a[i] = last;
      }
      return root;
    }
  }

  async function partition(target, width, height, budget, hooks = {}) {
    const integral = new Integral(target, width, height), heap = new Heap(), leaves = new Set();
    function schedule(node) {
      leaves.add(node); let best = null, gain = -1;
      // Use equality for flatness. Floating-point integral subtraction can
      // invent a tiny positive variance even when every source pixel agrees.
      const anchor=(node.y*width+node.x)*4;let uniform=true;
      flat: for(let y=node.y;y<node.y+node.h;y++)for(let x=node.x;x<node.x+node.w;x++)for(let c=0;c<4;c++){
        if(target[(y*width+x)*4+c]!==target[anchor+c]){uniform=false;break flat;}
      }
      if(uniform)return;
      for (let axis = 0; axis < 2; axis++) {
        const length = axis ? node.h : node.w;
        for (let k = 1; k < length; k++) {
          const a = integral.stats(node.x, node.y, axis ? node.w : k, axis ? k : node.h);
          const b = integral.stats(node.x + (axis ? 0 : k), node.y + (axis ? k : 0), axis ? node.w : node.w - k, axis ? node.h - k : node.h);
          const delta = node.error - a.error - b.error;
          if (delta > gain) { gain = delta; best = [a, b]; }
        }
      }
      if (best) { node.gain = Math.max(0, gain); node.children = best; heap.push(node); }
    }
    schedule(integral.stats(0, 0, width, height));
    while (leaves.size < budget && heap.items.length) {
      if (hooks.cancelled?.()) return null;
      const node = heap.pop(); leaves.delete(node);
      for (const child of node.children) schedule(child);
      if (leaves.size % 32 === 0) { hooks.progress?.(leaves.size, budget); await pause(); }
    }
    return Array.from(leaves);
  }

  // Exact RGBA runs, merged vertically only when their span and all four
  // bytes agree. No STD, floating-point variance or 255-pixel codec limit.
  async function lossless(rgba, width, height, hooks = {}, transpose = false) {
    const rows=transpose?width:height,columns=transpose?height:width,result=[];
    let active=new Map();
    const offset=(x,y)=>(transpose?x*width+y:y*width+x)*4;
    const packed=p=>((rgba[p+3]<<24)|(rgba[p]<<16)|(rgba[p+1]<<8)|rgba[p+2])>>>0;
    for(let y=0;y<rows;y++){
      if(hooks.cancelled?.())return null;
      const next=new Map();
      for(let x=0;x<columns;){
        const start=x,p=offset(x,y),color=packed(p);x++;
        while(x<columns&&packed(offset(x,y))===color)x++;
        if(color===hooks.skipColor)continue;
        const key=start+":"+(x-start)+":"+color;
        let node=active.get(key);
        if(node){if(transpose)node.w++;else node.h++;}
        else {
          const a=rgba[p+3]/255;
          node={x:transpose?y:start,y:transpose?start:y,w:transpose?1:x-start,h:transpose?x-start:1,
            color:[rgba[p]/255*a,rgba[p+1]/255*a,rgba[p+2]/255*a,a]};
          result.push(node);
        }
        next.set(key,node);
      }
      active=next;
      if(y%16===0){hooks.progress?.(y+1,rows);await pause();}
    }
    return result;
  }

  function toleranceMap(target, width, height, std, dynamic) {
    const gradient = new Float64Array(width * height), out = new Float64Array(width * height);
    const lum = p => 0.299 * Math.round(255*target[p]) + 0.587 * Math.round(255*target[p + 1]) + 0.114 * Math.round(255*target[p + 2]);
    if (dynamic && std > 0) {
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 4;
        gradient[p / 4] = Math.max(x ? Math.abs(lum(p) - lum(p - 4)) : 0, y ? Math.abs(lum(p) - lum(p - width * 4)) : 0);
      }
      const sums = new Integral(gradient, width, height, 1);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const x0 = Math.max(0, x - 2), y0 = Math.max(0, y - 2), w = Math.min(width, x + 3) - x0, h = Math.min(height, y + 3) - y0;
        const g = sums.rect(sums.sum[0], x0, y0, w, h) / (w * h);
        out[y * width + x] = std / 255 * (g > 30 ? 1 : g > 12 ? 2 : 3);
      }
    } else out.fill(std / 255);
    return out;
  }

  // Scan order and integer boundaries match the source algorithm's model.
  // Unlike its 5-byte codec, the site's exports can represent sizes >255.
  async function merge(target, width, height, std = 3, dynamic = true, hooks = {}) {
    // Integer sums/squares avoid cancellation inventing variance in a flat
    // region. On opaque inputs these are exactly the Python reference sums.
    const integer = new Int16Array(target.length);
    for(let p=0;p<target.length;p+=4){
      const a=target[p+3];integer[p+3]=Math.round(a*255);
      for(let c=0;c<3;c++)integer[p+c]=a>1e-9?Math.round(target[p+c]/a*255):0;
    }
    const integral = new Integral(integer, width, height), tolerance = toleranceMap(target, width, height, std, dynamic);
    const result = [];
    // Per-column occupancy permits only growth downwards from an uncovered
    // scan anchor. Future occupied pixels may start below that anchor, so use
    // an explicit bitmap to test the entire candidate row as well.
    const used = new Uint8Array(width * height);
    function availableHeight(x, y, w, cumulative = true) {
      let tol = Infinity, h = 0, anchor = Infinity;
      for (; h < 255 && y + h < height; h++) {
        if(!cumulative && h>0)tol=anchor;
        for (let xx = x; xx < x + w; xx++) {
          if (used[(y + h) * width + xx]) return h;
          tol = Math.min(tol, tolerance[(y + h) * width + xx]*255);
        }
        if(h===0)anchor=tol;
        if (integral.stats(x, y, w, h + 1).variance.some((v,c) => c===3||tol===0 ? v>1e-8 : Math.sqrt(v)>tol)) return h;
      }
      return h;
    }
    for (let y = 0; y < height; y++) {
      if (hooks.cancelled?.()) return null;
      for (let x = 0; x < width; x++) {
        if (used[y * width + x]) continue;
        let w = 1, tol = tolerance[y * width + x]*255;
        while (w < 255 && x + w < width && !used[y * width + x + w]) {
          tol = Math.min(tol, tolerance[y * width + x + w]*255);
          if (integral.stats(x, y, w + 1, 1).variance.some((v,c) => c===3||tol===0 ? v>1e-8 : Math.sqrt(v)>tol)) break;
          w++;
        }
        let bw = w, bh = availableHeight(x, y, w);
        for (let ww = w - 1; ww >= 1; ww--) {
          // The native narrowing pass tests the anchor and new row, rather
          // than retaining every previous row's minimum. Preserve that exact
          // behavior for the reference, including its tolerance-map quirk.
          const hh = availableHeight(x, y, ww, false);
          if (ww * hh > bw * bh) { bw = ww; bh = hh; }
        }
        const node = integral.stats(x, y, bw, bh), a=node.color[3]/255;
        node.color=[...node.color.slice(0,3).map(v=>v/255*a),a];result.push(node);
        for (let yy = y; yy < y + bh; yy++) used.fill(1, yy * width + x, yy * width + x + bw);
      }
      if (y % 4 === 0) { hooks.progress?.(y + 1, height); await pause(); }
    }
    return result;
  }
  return {Integral, Heap, prepare, partition, merge, lossless, toleranceMap};
})();
if (typeof module !== "undefined") module.exports = RectangleCompression;
