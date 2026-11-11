/* Focus detail: automatic focus maps (js/worker-importance.js) plus areas marked
 * by hand, combined into the importance map Primeval Turbo uses to place more
 * shapes where detail matters. Validated setting: strength 1, additive 3. */
(function () {
  const STRENGTH = 1, ADDITIVE = 3, CACHE_LIMIT = 24, MANUAL_SIZE = 256;
  const MODEL = "UNISAL static SALICON";
  const CANCELLED = "FOCUS_CANCELLED";
  let worker = null, sequence = 0, queue = Promise.resolve();
  const pending = new Map();
  const cache = new Map(); // File -> normalized map (or null for a flat image), oldest first

  function failAll(message) {
    for (const {reject} of pending.values()) reject(new Error(message));
    pending.clear();
  }

  function analysisWorker() {
    if (worker) return worker;
    const base=typeof document!=="undefined"?new URL("js/",document.baseURI):new URL("./",self.location.href);
    worker = new Worker(new URL("worker-importance.js?v=2",base), {type: "module"});
    worker.onmessage = ({data}) => {
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.map);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      failAll(event.message || "Focus analysis failed");
      worker.terminate();
      worker = null;
    };
    return worker;
  }

  /* Automatic map for one image. `token.abort()` cancels it: a running
   * analysis is stopped by terminating the worker. */
  function analyze(file, rgba, width, height, token) {
    if (cache.has(file)) {
      const map = cache.get(file);
      cache.delete(file);
      cache.set(file, map);
      return Promise.resolve(map);
    }
    const run = queue.then(() => new Promise((resolve, reject) => {
      if (token.cancelled) { reject(new Error(CANCELLED)); return; }
      const id = ++sequence;
      pending.set(id, {resolve, reject});
      token.abort = () => {
        if (!pending.has(id)) return;
        pending.delete(id);
        if (worker) { worker.terminate(); worker = null; }
        reject(new Error(CANCELLED));
      };
      const copy = rgba.slice();
      analysisWorker().postMessage({id, rgba: copy.buffer, width, height}, [copy.buffer]);
    }));
    queue = run.catch(() => {});
    return run.then((map) => {
      cache.set(file, map);
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
      return map;
    });
  }

  /* Importance for the fitter: marked areas get full weight on top of the
   * automatic map (or on an empty map when automatic focus is off). */
  function combine(automatic, areas, width, height) {
    let mapWidth, mapHeight, values;
    if (automatic) {
      mapWidth = automatic.width; mapHeight = automatic.height;
      values = Float32Array.from(automatic.values);
    } else if (areas.length) {
      const scale = MANUAL_SIZE / Math.max(width, height);
      mapWidth = Math.max(1, Math.round(width * scale));
      mapHeight = Math.max(1, Math.round(height * scale));
      values = new Float32Array(mapWidth * mapHeight);
    } else {
      return null;
    }
    for (const [x0, y0, x1, y1] of areas) {
      const left = Math.max(0, Math.floor(x0 * mapWidth)), right = Math.min(mapWidth, Math.ceil(x1 * mapWidth));
      const top = Math.max(0, Math.floor(y0 * mapHeight)), bottom = Math.min(mapHeight, Math.ceil(y1 * mapHeight));
      for (let y = top; y < bottom; y++) values.fill(1, y * mapWidth + left, y * mapWidth + right);
    }
    return {width: mapWidth, height: mapHeight, values, strength: STRENGTH, additive: ADDITIVE};
  }

  globalThis.Focus = {analyze, combine, CANCELLED, MODEL, STRENGTH, ADDITIVE};
})();
