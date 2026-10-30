//! Panic reporting. With `panic = "abort"` a panic traps the instance
//! (`RuntimeError: unreachable`) without its message, and a panic in a rayon
//! pool worker would leave the calling thread blocked forever. The hook sends
//! `render panicked: <message>` to the page before the trap, so the page can
//! reject the call and terminate the worker:
//!
//! - on the calling thread, through the `report` function the worker passed to
//!   [`set_panic_reporter`]; it posts on the worker's own port, ahead of
//!   anything the worker posts after the trap;
//! - on any other thread (a pool worker), on the worker-lifetime `BroadcastChannel`
//!   the page opened before it started the worker, because the calling thread
//!   is blocked in rayon and cannot post.

use js_sys::Function;
use primeval_js::{js_message, panic_error};
use std::cell::RefCell;
use std::panic::PanicHookInfo;
use std::sync::{Mutex, Once, PoisonError};
use wasm_bindgen::prelude::*;

/// The page's `BroadcastChannel` name, seen by every thread of the instance.
static CHANNEL: Mutex<Option<String>> = Mutex::new(None);
static INSTALL_HOOK: Once = Once::new();

thread_local! {
    /// Set only on the thread that called [`set_panic_reporter`].
    static REPORTER: RefCell<Option<Function>> = const { RefCell::new(None) };
}

#[wasm_bindgen(inline_js = "export function broadcast(name, message) {
  new BroadcastChannel(name).postMessage(message);
}")]
extern "C" {
    // `catch`, so a failure to report cannot throw through the hook.
    #[wasm_bindgen(catch)]
    fn broadcast(name: &str, message: &str) -> Result<(), JsValue>;
}

/// Installs the panic hook, once per instance, and sets where a panic is
/// reported: `report(message)` when it happens on this (the calling) thread,
/// and a `BroadcastChannel` named `channel` when it happens on another one.
#[wasm_bindgen(js_name = setPanicReporter)]
pub fn set_panic_reporter(channel: String, report: Function) {
    *CHANNEL.lock().unwrap_or_else(PoisonError::into_inner) = Some(channel);
    REPORTER.with(|reporter| *reporter.borrow_mut() = Some(report));
    INSTALL_HOOK.call_once(|| std::panic::set_hook(Box::new(hook)));
}

fn hook(info: &PanicHookInfo<'_>) {
    let message = js_message(&panic_error(info.payload()));
    // `try_*` throughout: a hook must not panic or block.
    let reporter = REPORTER
        .try_with(|reporter| reporter.try_borrow().ok().and_then(|r| r.clone()))
        .ok()
        .flatten();
    if let Some(report) = reporter {
        let _ = report.call1(&JsValue::UNDEFINED, &JsValue::from_str(&message));
        return;
    }
    if let Ok(channel) = CHANNEL.try_lock()
        && let Some(name) = channel.as_deref()
    {
        let _ = broadcast(name, &message);
    }
}

/// Panics on the calling thread, or inside a rayon task when `in_pool`
/// (which runs on a pool worker in the threaded build). Only for the browser
/// runtime's panic tests; not part of the API.
#[doc(hidden)]
#[wasm_bindgen(js_name = __panicForTests)]
pub fn panic_for_tests(in_pool: bool) {
    if in_pool {
        use rayon::prelude::*;
        (0..64_u32).into_par_iter().for_each(|index| {
            if index == 63 {
                panic!("panic for tests in a rayon task");
            }
        });
    } else {
        panic!("panic for tests on the calling thread");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[should_panic(expected = "panic for tests on the calling thread")]
    fn panic_for_tests_panics_on_the_calling_thread() {
        panic_for_tests(false);
    }

    #[test]
    #[should_panic(expected = "panic for tests in a rayon task")]
    fn panic_for_tests_panics_in_a_rayon_task() {
        panic_for_tests(true);
    }
}
