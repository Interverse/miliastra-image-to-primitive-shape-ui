//! Runs the Divan benchmarks compiled into `primeval-render` by its `bench`
//! feature (`src/benches.rs`):
//!
//! ```text
//! cargo bench -p primeval-render --features bench --bench render
//! ```

// Link the library so its registered benchmarks are part of this binary.
use primeval_render as _;

fn main() {
    divan::main();
}
