// The browser runtime behind browser.ts. Internal: not a public entry point.
//
// Calls take the page's idle module worker or start one of their build
// (worker-single.ts or worker-threaded.ts). Only a delivered result keeps its
// worker idle, for up to 10 seconds; at most one is retained. Every failure
// terminates the worker, its instance, memory and thread pool immediately.
// Concurrent calls have separate workers and memory. The page picks the build
// before fetching anything and compiles its `.wasm` once. Fresh workers load
// one at a time (see `queueStart`); reused workers bypass that gate and retain
// their instance, pool and panic channel, receiving only the next task.
import { InternalError, mapNativeError, messageOf } from "./errors.js";
import { abortError, normalizeRequest } from "./request.js?v=fast-1";
const IDLE_MS = 10_000;
let idleMs = IDLE_MS;
let workersStarted = 0;
const modules = new Map();
function selectVariant() {
    return globalThis.crossOriginIsolated === true ? "threaded" : "single";
}
// Literal URLs, one per variant, so bundlers can see both.
function wasmUrl(variant) {
    return variant === "threaded"
        ? new URL("../wasm/threaded/primeval_bg.wasm?v=fast-1", import.meta.url)
        : new URL("../wasm/single/primeval_bg.wasm?v=fast-1", import.meta.url);
}
// Literal URLs, one per variant, so bundlers can see both workers.
function startWorker(variant) {
    const threadedUrl = new URL("./worker-threaded.js?v=fast-1", import.meta.url);
    if (globalThis.PRIMEVAL_THREADS) threadedUrl.searchParams.set("threads", String(globalThis.PRIMEVAL_THREADS));
    const worker = variant === "threaded"
        ? new Worker(threadedUrl, { type: "module" })
        : new Worker(new URL("./worker-single.js?v=fast-1", import.meta.url), { type: "module" });
    workersStarted += 1;
    return worker;
}
/**
 * The smallest module with a SIMD instruction (`i8x16.popcnt` of an
 * `i8x16.splat`), from the final SIMD proposal: browsers without WebAssembly
 * SIMD do not validate it.
 */
const SIMD_PROBE = Uint8Array.from([
    ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00], // magic, version
    ...[0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b], // types: () -> v128
    ...[0x03, 0x02, 0x01, 0x00], // functions: one of that type
    ...[0x0a, 0x0a, 0x01, 0x08, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0xfd, 0x62, 0x0b], // its code
]);
/**
 * The error for a `.wasm` that failed to load or compile: both builds need
 * WebAssembly SIMD, so a browser without it is told which browsers have it.
 */
function loadError(error) {
    let simd = false;
    try {
        simd = WebAssembly.validate(SIMD_PROBE);
    }
    catch {
        // An engine that cannot even validate the probe has no SIMD.
    }
    return simd
        ? new InternalError(`could not load the WebAssembly module: ${messageOf(error)}`, {
            cause: error,
        })
        : new InternalError("this browser does not support WebAssembly SIMD, which primeval needs: " +
            "use Chrome 91, Firefox 89, Safari 16.4 or newer", { cause: error });
}
/** The compiled module of `variant`, once per page; a failure is retried next call. */
function compiledModule(variant) {
    let module = modules.get(variant);
    if (module === undefined) {
        const compiling = WebAssembly.compileStreaming(fetch(wasmUrl(variant)));
        compiling.catch(() => {
            if (modules.get(variant) === compiling) {
                modules.delete(variant);
            }
        });
        modules.set(variant, compiling);
        module = compiling;
    }
    return module;
}
/**
 * Resolves once the latest fresh worker has started or been terminated,
 * and so has every fresh worker before it. A worker has started once its
 * modules are loaded and, in the threaded build, those of all its pool
 * workers too.
 */
let startGate = Promise.resolve();
/**
 * Queues an acquisition of a fresh worker (`acquire`) at the start gate:
 * `turn` resolves when it may start, and `release`, once the worker has
 * started or been terminated (or acquisition was aborted), lets the next
 * fresh worker start. So the package never has two workers loading at once,
 * which WebKit fails on a page isolated by a service worker
 * (https://bugs.webkit.org/show_bug.cgi?id=261734). An acquisition released
 * before its turn, by an abort, still holds the next acquisition until its
 * own turn comes. Calls served by the idle worker bypass the gate.
 */
function queueStart() {
    const turn = startGate;
    let release = () => undefined;
    const started = new Promise((resolve) => {
        release = resolve;
    });
    startGate = Promise.all([turn, started]).then(() => undefined);
    return { turn, release };
}
/** A name no other worker or page uses, for the worker's panic channel. */
function channelName() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return `primeval-panic-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
/**
 * The error Node rejects with for the same Rust error: the worker's plain
 * fields become a native-like `Error`, mapped by the Node mapping.
 */
function errorFromWorker({ code, message, option, requirement }) {
    const cause = Object.assign(new Error(message), { code }, option === undefined ? {} : { option, requirement });
    return mapNativeError(cause);
}
/** The page's sole successful worker waiting for reuse, or no idle worker. */
let idle;
/** Clears the call's handlers, retaining only a worker that delivered a result. */
function release(runtime, reusable) {
    runtime.onMessage = undefined;
    runtime.fail = undefined;
    if (reusable) {
        retain(runtime);
    }
    else {
        if (idle?.runtime === runtime) {
            clearTimeout(idle.timer);
            idle = undefined;
        }
        runtime.worker.terminate();
        runtime.channel.close();
        runtime.releaseStart();
    }
}
/** Ends the entire worker lifetime, including its panic channel. */
function terminate(runtime) {
    release(runtime, false);
}
function retain(runtime) {
    if (idle !== undefined || idleMs === 0) {
        terminate(runtime);
        return;
    }
    idle = { runtime, timer: setTimeout(() => terminate(runtime), idleMs) };
}
function takeIdle() {
    if (idle === undefined) {
        return undefined;
    }
    const { runtime, timer } = idle;
    clearTimeout(timer);
    idle = undefined;
    return runtime;
}
/** Open the panic channel before starting the worker; it belongs to its life. */
function createWorker(variant, module, releaseStart) {
    const channel = new BroadcastChannel(channelName());
    let worker;
    try {
        worker = startWorker(variant);
    }
    catch (error) {
        channel.close();
        throw error;
    }
    const runtime = { worker, channel, releaseStart };
    const fail = (error) => {
        if (runtime.fail !== undefined) {
            runtime.fail(error);
        }
        else {
            terminate(runtime);
        }
    };
    channel.onmessage = (event) => fail(errorFromWorker({ code: "INTERNAL", message: String(event.data) }));
    worker.onmessage = (event) => {
        if (event.data.type === "started") {
            releaseStart();
        }
        else if (runtime.onMessage !== undefined) {
            runtime.onMessage(event.data);
        }
        else if (event.data.type === "error") {
            fail(errorFromWorker(event.data.error));
        }
    };
    worker.onerror = (event) => {
        event.preventDefault();
        fail(new InternalError("the primeval worker failed to load or crashed"));
    };
    worker.onmessageerror = () => fail(new InternalError("a message from the primeval worker could not be read"));
    try {
        worker.postMessage({ type: "init", module, channel: channel.name });
    }
    catch (error) {
        terminate(runtime);
        throw error;
    }
    return runtime;
}
/** Takes the idle worker, or compiles and starts a fresh worker at its gate turn. */
function acquire(variant, signal) {
    const runtime = takeIdle();
    if (runtime !== undefined) {
        return Promise.resolve(runtime);
    }
    const gate = queueStart();
    return new Promise((resolve, reject) => {
        const fail = (error) => {
            signal?.removeEventListener("abort", onAbort);
            gate.release();
            reject(error);
        };
        const onAbort = () => fail(abortError(signal));
        signal?.addEventListener("abort", onAbort, { once: true });
        // The turn never rejects: a failure is the compile's.
        let module;
        try {
            module = compiledModule(variant);
        }
        catch (error) {
            fail(loadError(error));
            return;
        }
        Promise.all([module, gate.turn]).then(([module]) => {
            if (signal?.aborted) {
                return;
            }
            try {
                const runtime = createWorker(variant, module, gate.release);
                signal?.removeEventListener("abort", onAbort);
                resolve(runtime);
            }
            catch (error) {
                fail(new InternalError(`could not start the primeval worker: ${messageOf(error)}`, {
                    cause: error,
                }));
            }
        }, (error) => fail(loadError(error)));
    });
}
/**
 * Runs one task in an idle worker or a fresh one through the start gate.
 * The first reason to stop wins. Only a delivered result permits reuse.
 */
async function runInWorker(task, onProgress, signal) {
    const runtime = await acquire(selectVariant(), signal);
    if (signal?.aborted) {
        release(runtime, false);
        throw abortError(signal);
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (finish, reusable = false) => {
            if (settled) {
                return;
            }
            settled = true;
            release(runtime, reusable);
            signal?.removeEventListener("abort", onAbort);
            finish();
        };
        const fail = (error) => settle(() => reject(error));
        const onAbort = () => fail(abortError(signal));
        signal?.addEventListener("abort", onAbort, { once: true });
        const onMessage = (message) => {
            if (settled) {
                return;
            }
            switch (message.type) {
                case "loaded":
                case "started":
                    break;
                case "progress":
                    try {
                        onProgress?.(message.info);
                    }
                    catch (error) {
                        fail(error);
                    }
                    break;
                case "result":
                    // An abort before the result is delivered wins, as on Node.
                    if (signal?.aborted) {
                        fail(abortError(signal));
                    }
                    else {
                        settle(() => resolve(message.result), true);
                    }
                    break;
                case "error":
                    fail(errorFromWorker(message.error));
                    break;
            }
        };
        runtime.onMessage = onMessage;
        runtime.fail = fail;
        try {
            const request = { type: "run", progress: onProgress !== undefined, task };
            const transfer = task.kind === "approximate" ? [task.input.buffer] : [];
            runtime.worker.postMessage(request, transfer);
        }
        catch (error) {
            fail(new InternalError(`could not start the primeval worker: ${messageOf(error)}`, {
                cause: error,
            }));
        }
    });
}
/** Validates `request` and renders it in a worker. Used by browser.ts. */
export async function approximateInWorker(request) {
    const { input, output, render, onProgress, signal } = normalizeRequest(request);
    if (signal?.aborted) {
        throw abortError(signal);
    }
    // A copy of only the viewed bytes, transferred to the worker; the caller's
    // array is left as it is.
    const task = { kind: "approximate", input: input.slice(), output, render };
    return runInWorker(task, onProgress, signal);
}
/**
 * Internal, for the browser tests only: panics in a calling worker, on the
 * calling thread or in a rayon pool task, through binding-wasm's hidden
 * `__panicForTests`. Rejects with the `InternalError` a render panic gives.
 *
 * @testonly
 */
export async function panicForTests(site) {
    await runInWorker({ kind: "panic", site }, undefined, undefined);
    throw new InternalError("the test panic did not reject");
}
/**
 * Clears the idle slot and sets its lifetime; omitted restores the default.
 * Zero terminates successful workers at settle, disabling reuse.
 * @testonly
 */
export function setIdleMsForTests(ms = IDLE_MS) {
    if (idle !== undefined) {
        terminate(idle.runtime);
    }
    idleMs = ms;
}
/**
 * Number of calling workers started by this page runtime (not pool workers).
 * @testonly
 */
export function workersStartedForTests() {
    return workersStarted;
}
