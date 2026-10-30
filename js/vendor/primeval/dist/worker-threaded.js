// The calling worker of the threaded build, and also each of its rayon pool
// workers: the calling worker starts its pool workers from this same file,
// and the first message tells the two roles apart. The glue import is static
// so that bundlers bundle it with its snippets and `.wasm` asset.
import * as glueModule from "../wasm/threaded/primeval.js";
import { messageOf } from "./errors.js";
import { requestRunner, scope } from "./worker-common.js";
const glue = glueModule;
// Kept for the life of this worker. The builder owns the channel whose
// receiver the pool workers block on, so it must outlive them. The `Worker`
// objects keep Firefox from collecting workers that share the memory but are
// not otherwise rooted (https://bugzilla.mozilla.org/show_bug.cgi?id=1702191).
let builder;
const poolWorkers = [];
/** Starts one pool worker; both of its promises reject if it fails. */
function spawnPoolWorker(init) {
    const worker = new Worker(new URL("./worker-threaded.js", import.meta.url), {
        type: "module",
    });
    poolWorkers.push(worker);
    const until = (expected) => new Promise((resolve, reject) => {
        worker.addEventListener("message", ({ data }) => {
            if (data.type === expected) {
                resolve();
            }
            else if (data.type === "failed") {
                reject(new Error(data.message));
            }
        });
        worker.addEventListener("error", (event) => {
            event.preventDefault();
            reject(new Error("a pool worker failed to load"));
        });
    });
    const start = { loaded: until("loaded"), ready: until("ready") };
    // Awaited only once every pool worker has loaded: a failure before then is
    // handled there, not unhandled.
    start.ready.catch(() => undefined);
    worker.postMessage(init);
    return start;
}
/**
 * The rayon pool, one thread per logical core, each on a pool worker. The
 * pool workers start one at a time, each once the previous one has loaded its
 * modules, since WebKit fails module workers started together on a page
 * isolated by a service worker (https://bugs.webkit.org/show_bug.cgi?id=261734);
 * their instantiation still overlaps. Once the last one has loaded, the page
 * is told that this call's workers have started.
 */
async function startPool(module) {
    const requested=Number(new URL(import.meta.url).searchParams.get("threads"));
    builder = new glue.PoolBuilder(requested>0?Math.min(navigator.hardwareConcurrency,Math.floor(requested)):navigator.hardwareConcurrency);
    const init = {
        type: "pool",
        module,
        memory: glue.wasmMemory(),
        receiver: builder.receiver(),
    };
    const ready = [];
    for (let k = 0; k < builder.numThreads; k += 1) {
        const start = spawnPoolWorker(init);
        ready.push(start.ready);
        await start.loaded;
    }
    scope.postMessage({ type: "started" });
    await Promise.all(ready);
    builder.build();
}
/** A pool worker: joins the calling worker's instance and runs one rayon thread. */
async function runPoolWorker({ module, memory, receiver }) {
    try {
        await glue.default({ module_or_path: module, memory });
    }
    catch (error) {
        scope.postMessage({ type: "failed", message: messageOf(error) });
        return;
    }
    scope.postMessage({ type: "ready" });
    // Blocks for the life of the pool. A panic here reaches the page on the
    // worker's BroadcastChannel: this thread has no reporter of its own.
    glue.startPoolWorker(receiver);
}
const run = requestRunner(glue, startPool);
scope.onmessage = ({ data }) => {
    switch (data.type) {
        case "pool":
            // A pool worker keeps this role and blocks in its rayon thread.
            scope.onmessage = null;
            void runPoolWorker(data);
            break;
        case "init":
        case "run":
            void run(data);
            break;
    }
};
// Every worker of this file, whatever its role: its caller (the page, which
// ignores it, or the calling worker of a pool worker) learns that its modules
// are loaded.
scope.postMessage({ type: "loaded" });
