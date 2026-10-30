use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Env, JsError};
use napi_derive::napi;
use primeval_js::{
    JsAlpha, JsRenderOptions, JsSeed, js_error_fields, normalize_request, panic_error,
};
use primeval_render::{
    ApproximateError, ApproximateRequest, ApproximateResult, CancellationToken, Execution,
    ProgressInfo, approximate,
};
use std::panic::{AssertUnwindSafe, catch_unwind};

#[napi(object, object_to_js = false)]
pub struct NativeRenderOptions {
    /// JavaScript numbers arrive as `f64`; Rust checks they are integers in
    /// range, so nothing wraps or truncates at this boundary.
    pub count: Option<f64>,
    pub shape: Option<String>,
    /// `"auto"` or a number; Rust validates both.
    pub alpha: Option<Either<f64, String>>,
    /// A safe-integer number or a `bigint` in `0..=2^64 - 1`.
    pub seed: Option<Either<f64, BigInt>>,
    pub background: Option<String>,
    #[napi(js_name = "resizeInput")]
    pub resize_input: Option<f64>,
    #[napi(js_name = "outputSize")]
    pub output_size: Option<f64>,
}

#[napi(object, object_to_js = false)]
pub struct NativeExecutionOptions {
    #[napi(js_name = "onProgress")]
    pub on_progress: Option<ThreadsafeFunction<NativeProgressInfo>>,
}

#[napi(object, object_to_js = false)]
pub struct NativeApproximateRequest {
    pub input: Buffer,
    pub output: String,
    pub render: NativeRenderOptions,
    pub execution: Option<NativeExecutionOptions>,
}

#[napi(object)]
pub struct NativeProgressInfo {
    pub step: u32,
    pub total: u32,
    pub score: f64,
    pub shape: String,
}

#[napi(object)]
pub struct NativeApproximateResult {
    pub format: String,
    pub data: Buffer,
    #[napi(js_name = "mimeType")]
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
}

/// Handle to one running render. Dropping it does not cancel the render.
#[napi]
pub struct NativeTask {
    token: CancellationToken,
}

#[napi]
impl NativeTask {
    /// Requests cancellation; the render stops before its next step.
    #[napi]
    pub fn cancel(&self) {
        self.token.cancel();
    }
}

/// Starts a render on the tokio blocking pool and returns
/// `{ promise, task }`.
///
/// Errors carry the stable code from [`ApproximateError::code`] as `err.code`.
#[napi(
    js_name = "startApproximate",
    ts_return_type = "{ promise: Promise<NativeApproximateResult>; task: NativeTask }"
)]
pub fn start_approximate(env: &Env, request: NativeApproximateRequest) -> Result<Object<'_>> {
    let NativeApproximateRequest {
        input,
        output,
        render,
        execution,
    } = request;
    let progress = execution.and_then(|execution| execution.on_progress);
    let request = normalize_request(input.into(), &output, render.into())
        .map_err(|error| js_error(env, &error))?;
    let token = CancellationToken::new();
    let task_token = token.clone();

    let promise = env.spawn_future_with_callback(
        async move {
            // The render is CPU-bound: run it on the blocking pool, not on a
            // tokio worker.
            let joined =
                spawn_blocking(move || catch_panic(|| render_request(request, &token, progress)))
                    .await;
            Ok(joined.unwrap_or_else(|join_error| {
                Err(ApproximateError::internal(format!(
                    "render task failed: {join_error}"
                )))
            }))
        },
        |env, outcome| {
            outcome
                .map(NativeApproximateResult::from)
                .map_err(|error| js_error(env, &error))
        },
    )?;

    let mut handle = Object::new(env)?;
    handle.set("promise", promise)?;
    handle.set("task", NativeTask { token: task_token })?;
    Ok(handle)
}

fn render_request(
    request: ApproximateRequest,
    token: &CancellationToken,
    progress: Option<ThreadsafeFunction<NativeProgressInfo>>,
) -> std::result::Result<ApproximateResult, ApproximateError> {
    let mut on_progress = |info: ProgressInfo| {
        if let Some(tsfn) = progress.as_ref() {
            let _ = tsfn.call(
                Ok(NativeProgressInfo {
                    step: info.step,
                    total: info.total,
                    score: info.score,
                    shape: info.shape,
                }),
                ThreadsafeFunctionCallMode::NonBlocking,
            );
        }
    };
    let execution = Execution::new().cancellation(token);
    let execution = if progress.is_some() {
        execution.progress(&mut on_progress)
    } else {
        execution
    };
    approximate(request, execution)
}

/// Runs `f`, turning a panic into an internal error that carries the panic
/// message. The release profile unwinds, and rayon re-raises worker panics
/// on the calling thread, so this catches panics anywhere in the render.
fn catch_panic<T>(
    f: impl FnOnce() -> std::result::Result<T, ApproximateError>,
) -> std::result::Result<T, ApproximateError> {
    catch_unwind(AssertUnwindSafe(f)).unwrap_or_else(|payload| Err(panic_error(payload.as_ref())))
}

impl From<NativeRenderOptions> for JsRenderOptions {
    fn from(render: NativeRenderOptions) -> Self {
        Self {
            count: render.count,
            shape: render.shape,
            alpha: render.alpha.map(|alpha| match alpha {
                Either::A(alpha) => JsAlpha::Number(alpha),
                Either::B(alpha) => JsAlpha::Text(alpha),
            }),
            seed: render.seed.map(|seed| match seed {
                Either::A(seed) => JsSeed::Number(seed),
                Either::B(seed) => bigint_seed(&seed),
            }),
            background: render.background,
            resize_input: render.resize_input,
            output_size: render.output_size,
        }
    }
}

/// A `bigint` seed must be in `0..=u64::MAX`.
fn bigint_seed(seed: &BigInt) -> JsSeed {
    let (negative, value, lossless) = seed.get_u64();
    if negative || !lossless {
        JsSeed::BigIntOutOfRange
    } else {
        JsSeed::BigInt(value)
    }
}

/// A JavaScript `Error` whose `code` is the stable error code. An invalid
/// option also carries `option` (its JavaScript name) and `requirement`, so other
/// surfaces such as the CLI can print their own spelling without parsing the
/// message.
///
/// napi-rs only sets a string `code` on errors it creates from an
/// `Error<S: AsRef<str>>`; the promise path takes `Error<Status>`, so the
/// error object is created here and passed through as a reference.
fn js_error(env: &Env, error: &ApproximateError) -> Error {
    let fields = js_error_fields(error);
    let unknown = JsError::from(Error::new(fields.code, fields.message)).into_unknown(*env);
    if let Some(invalid) = fields.invalid_option
        && let Ok(mut object) = Object::from_unknown(unknown)
    {
        // Failing to add a property still leaves a usable coded error.
        let _ = object.set("option", invalid.option);
        let _ = object.set("requirement", invalid.requirement);
    }
    Error::from(unknown)
}

impl From<ApproximateResult> for NativeApproximateResult {
    fn from(value: ApproximateResult) -> Self {
        let fmt = value.format();
        let format = fmt.extension().to_string();
        let mime_type = fmt.mime_type().to_string();
        let width = value.width();
        let height = value.height();
        let data = Buffer::from(value.into_bytes());
        Self {
            format,
            data,
            mime_type,
            width,
            height,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bigint(sign_bit: bool, words: Vec<u64>) -> BigInt {
        BigInt { sign_bit, words }
    }

    #[test]
    fn bigint_seeds_cover_the_full_u64_range() {
        for value in [0, 7, u64::MAX] {
            assert_eq!(
                bigint_seed(&bigint(false, vec![value])),
                JsSeed::BigInt(value)
            );
        }
        for seed in [bigint(true, vec![1]), bigint(false, vec![0, 1])] {
            assert_eq!(bigint_seed(&seed), JsSeed::BigIntOutOfRange);
        }
    }

    #[test]
    fn native_render_options_convert_field_by_field() {
        let render = JsRenderOptions::from(NativeRenderOptions {
            count: Some(1.0),
            shape: Some("circle".to_string()),
            alpha: Some(Either::B("auto".to_string())),
            seed: Some(Either::A(7.0)),
            background: Some("#fff".to_string()),
            resize_input: Some(32.0),
            output_size: Some(64.0),
        });

        assert_eq!(
            render,
            JsRenderOptions {
                count: Some(1.0),
                shape: Some("circle".to_string()),
                alpha: Some(JsAlpha::Text("auto".to_string())),
                seed: Some(JsSeed::Number(7.0)),
                background: Some("#fff".to_string()),
                resize_input: Some(32.0),
                output_size: Some(64.0),
            }
        );
        assert_eq!(
            JsRenderOptions::from(NativeRenderOptions {
                count: None,
                shape: None,
                alpha: Some(Either::A(9.0)),
                seed: None,
                background: None,
                resize_input: None,
                output_size: None,
            }),
            JsRenderOptions {
                alpha: Some(JsAlpha::Number(9.0)),
                ..JsRenderOptions::default()
            }
        );
    }

    #[test]
    fn catch_panic_turns_a_panic_into_an_internal_error() {
        let result: std::result::Result<(), _> = catch_panic(|| panic!("boom {}", 7));

        match result {
            Err(error @ ApproximateError::Internal { .. }) => {
                assert_eq!(error.code(), "INTERNAL");
                assert_eq!(
                    primeval_js::js_message(&error),
                    "internal render error: render panicked: boom 7"
                );
            }
            other => panic!("expected internal error, got {other:?}"),
        }
    }

    #[test]
    fn catch_panic_passes_results_through() {
        assert_eq!(catch_panic(|| Ok(5)).ok(), Some(5));
        assert!(matches!(
            catch_panic::<()>(|| Err(ApproximateError::Aborted)),
            Err(ApproximateError::Aborted)
        ));
    }
}
