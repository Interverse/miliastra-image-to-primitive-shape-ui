//! The napi-rs addon of the Node package (`primeval-node`): `startApproximate`
//! runs a `primeval-render` render off the event loop, cancellable, with
//! panics caught. `docs/architecture.md` in the repository describes how it
//! fits with the loader and the TypeScript wrapper.

mod binding;

pub use binding::*;
