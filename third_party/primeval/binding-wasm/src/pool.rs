//! The rayon pool of the threaded build, on Web Workers the browser runtime
//! starts (`src/worker-threaded.ts`). The same idea as `wasm-bindgen-rayon`
//! (Apache-2.0), without its JavaScript helper:
//!
//! 1. the calling thread creates a [`PoolBuilder`] for `n` threads;
//! 2. it starts `n` pool workers, each of which instantiates this module with
//!    the same compiled module and shared [`memory`], and then blocks in
//!    [`start_pool_worker`] on the builder's [`PoolBuilder::receiver`];
//! 3. once every pool worker is ready, [`PoolBuilder::build`] makes the
//!    global rayon pool, whose spawn handler sends each rayon thread to one of
//!    them over the channel.
//!
//! A channel, not `postMessage`: the calling thread is blocked while rayon
//! spawns its threads, so it could not post anyway.

// `atomics` is detectable in `target_feature`, `bulk-memory` is not; this
// catches a threaded build without the RUSTFLAGS in scripts/build-wasm.mjs.
#[cfg(all(target_arch = "wasm32", not(doc), not(target_feature = "atomics")))]
compile_error!("the `threads` feature needs the threaded RUSTFLAGS of scripts/build-wasm.mjs");

use crossbeam_channel::{Receiver, Sender, bounded};
use rayon::{ThreadBuilder, ThreadPoolBuilder};
use wasm_bindgen::prelude::*;

/// Builds the global rayon pool on pool workers the caller starts.
#[wasm_bindgen]
pub struct PoolBuilder {
    num_threads: usize,
    sender: Sender<ThreadBuilder>,
    receiver: Receiver<ThreadBuilder>,
}

#[wasm_bindgen]
impl PoolBuilder {
    /// A builder for `num_threads` rayon threads, at least 1.
    #[wasm_bindgen(constructor)]
    pub fn new(num_threads: usize) -> Self {
        let num_threads = num_threads.max(1);
        // Room for every thread, so `build` never blocks on a send.
        let (sender, receiver) = bounded(num_threads);
        Self {
            num_threads,
            sender,
            receiver,
        }
    }

    /// The number of pool workers to start, one per rayon thread.
    #[wasm_bindgen(getter, js_name = numThreads)]
    pub fn num_threads(&self) -> usize {
        self.num_threads
    }

    /// The address of the channel's receiver, for [`start_pool_worker`].
    /// Valid while this builder is alive: the caller keeps it until its
    /// worker ends.
    pub fn receiver(&self) -> *const Receiver<ThreadBuilder> {
        &self.receiver
    }

    /// Builds the global rayon pool. Call it once every pool worker is
    /// blocked in [`start_pool_worker`].
    ///
    /// # Errors
    ///
    /// Fails if the global pool already exists.
    pub fn build(&self) -> Result<(), JsError> {
        ThreadPoolBuilder::new()
            .num_threads(self.num_threads)
            .spawn_handler(|thread| {
                // Cannot fail while `self` holds the receiver.
                self.sender
                    .send(thread)
                    .map_err(|_| std::io::Error::other("the pool channel is closed"))
            })
            .build_global()
            .map_err(|error| JsError::new(&error.to_string()))
    }
}

/// Runs one pool worker: waits for its rayon thread on `receiver` (from
/// [`PoolBuilder::receiver`]) and runs it. Never returns while the pool
/// lives.
#[wasm_bindgen(js_name = startPoolWorker)]
#[allow(clippy::not_unsafe_ptr_arg_deref)]
pub fn start_pool_worker(receiver: *const Receiver<ThreadBuilder>)
where
    // Statically asserts that a `Receiver` may be shared with other threads.
    Receiver<ThreadBuilder>: Sync,
{
    // SAFETY: `receiver` comes from `PoolBuilder::receiver`, a reference into
    // a builder that wasm-bindgen allocated on the heap and that the calling
    // thread keeps alive (and so does not move or drop) until its worker,
    // and with it this whole instance, ends. Only a caller passing another
    // value breaks this, and nothing on the Rust side could prevent that.
    let receiver = unsafe { &*receiver };
    match receiver.recv() {
        Ok(thread) => thread.run(),
        Err(_) => wasm_bindgen::throw_str("the pool channel closed before a thread was sent"),
    }
}

/// This instance's (shared) memory, for the pool workers to instantiate with.
#[wasm_bindgen(js_name = wasmMemory)]
pub fn memory() -> JsValue {
    wasm_bindgen::memory()
}
