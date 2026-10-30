//! Runs the Divan benchmarks compiled into `primeval-core` by its `bench`
//! feature (`src/benches.rs`):
//!
//! ```text
//! cargo bench -p primeval-core --features bench --bench core
//! ```

// Link the library so its registered benchmarks are part of this binary.
use primeval_core as _;

fn main() {
    divan::main();
}
