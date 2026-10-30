//! The host-testable part of the request: turning classified JavaScript
//! field values into [`JsRenderOptions`].

use primeval_js::{JsAlpha, JsRenderOptions, JsSeed};
use primeval_render::{ApproximateError, RenderOption};

/// The JavaScript type of one render field, with its value where the request
/// can use it.
#[derive(Debug, PartialEq)]
pub(crate) enum JsField {
    /// `undefined`, or a missing property.
    Absent,
    Number(f64),
    Text(String),
    /// A `bigint`: `Some` if it is in `0..=u64::MAX`, `None` otherwise.
    BigInt(Option<u64>),
    /// Any other type, including `null`.
    Other,
}

/// Builds the render options from each field's value, read in order with
/// `field`; the first failing read stops and returns its error. A field of
/// the wrong type is an invalid value for that option, returned through
/// `invalid`.
pub(crate) fn render_options<E>(
    mut field: impl FnMut(RenderOption) -> Result<JsField, E>,
    invalid: impl Fn(ApproximateError) -> E,
) -> Result<JsRenderOptions, E> {
    let mut read = |option: RenderOption| field(option).map(|value| (option, value));
    let invalid = |option| invalid(ApproximateError::invalid_option(option));
    Ok(JsRenderOptions {
        count: number(read(RenderOption::Count)?).map_err(invalid)?,
        shape: text(read(RenderOption::Shape)?).map_err(invalid)?,
        alpha: match read(RenderOption::Alpha)? {
            (_, JsField::Absent) => None,
            (_, JsField::Number(alpha)) => Some(JsAlpha::Number(alpha)),
            (_, JsField::Text(alpha)) => Some(JsAlpha::Text(alpha)),
            (option, _) => return Err(invalid(option)),
        },
        seed: match read(RenderOption::Seed)? {
            (_, JsField::Absent) => None,
            (_, JsField::Number(seed)) => Some(JsSeed::Number(seed)),
            (_, JsField::BigInt(Some(seed))) => Some(JsSeed::BigInt(seed)),
            (_, JsField::BigInt(None)) => Some(JsSeed::BigIntOutOfRange),
            (option, _) => return Err(invalid(option)),
        },
        background: text(read(RenderOption::Background)?).map_err(invalid)?,
        resize_input: number(read(RenderOption::ResizeInput)?).map_err(invalid)?,
        output_size: number(read(RenderOption::OutputSize)?).map_err(invalid)?,
    })
}

/// A number field; `Err` holds the option of a field of another type.
fn number((option, value): (RenderOption, JsField)) -> Result<Option<f64>, RenderOption> {
    match value {
        JsField::Absent => Ok(None),
        JsField::Number(number) => Ok(Some(number)),
        _ => Err(option),
    }
}

/// A string field; `Err` holds the option of a field of another type.
fn text((option, value): (RenderOption, JsField)) -> Result<Option<String>, RenderOption> {
    match value {
        JsField::Absent => Ok(None),
        JsField::Text(text) => Ok(Some(text)),
        _ => Err(option),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use primeval_js::js_message;

    /// Reads `values` (absent if not listed); an invalid option is returned
    /// as it is.
    fn read(values: Vec<(RenderOption, JsField)>) -> Result<JsRenderOptions, ApproximateError> {
        let mut values = values;
        render_options(
            |option| {
                Ok(values
                    .iter()
                    .position(|(name, _)| *name == option)
                    .map_or(JsField::Absent, |index| values.swap_remove(index).1))
            },
            |error| error,
        )
    }

    #[test]
    fn absent_fields_stay_absent() {
        assert_eq!(read(vec![]).expect("no fields"), JsRenderOptions::default());
    }

    #[test]
    fn fields_of_the_accepted_types_convert() {
        let render = read(vec![
            (RenderOption::Count, JsField::Number(10.0)),
            (RenderOption::Shape, JsField::Text("circle".into())),
            (RenderOption::Alpha, JsField::Text("auto".into())),
            (RenderOption::Seed, JsField::BigInt(Some(u64::MAX))),
            (RenderOption::Background, JsField::Text("#fff".into())),
            (RenderOption::ResizeInput, JsField::Number(64.0)),
            (RenderOption::OutputSize, JsField::Number(128.0)),
        ])
        .expect("valid fields");

        assert_eq!(
            render,
            JsRenderOptions {
                count: Some(10.0),
                shape: Some("circle".into()),
                alpha: Some(JsAlpha::Text("auto".into())),
                seed: Some(JsSeed::BigInt(u64::MAX)),
                background: Some("#fff".into()),
                resize_input: Some(64.0),
                output_size: Some(128.0),
            }
        );

        let render = read(vec![
            (RenderOption::Alpha, JsField::Number(9.0)),
            (RenderOption::Seed, JsField::Number(3.0)),
        ])
        .expect("number alpha and seed");
        assert_eq!(render.alpha, Some(JsAlpha::Number(9.0)));
        assert_eq!(render.seed, Some(JsSeed::Number(3.0)));

        let render = read(vec![(RenderOption::Seed, JsField::BigInt(None))])
            .expect("the range is checked when the request is normalized");
        assert_eq!(render.seed, Some(JsSeed::BigIntOutOfRange));
    }

    #[test]
    fn a_field_of_the_wrong_type_is_an_invalid_option() {
        let wrong: [(RenderOption, Vec<JsField>); 7] = [
            (
                RenderOption::Count,
                vec![
                    JsField::Text("1".into()),
                    JsField::BigInt(Some(1)),
                    JsField::Other,
                ],
            ),
            (
                RenderOption::Shape,
                vec![
                    JsField::Number(1.0),
                    JsField::BigInt(Some(1)),
                    JsField::Other,
                ],
            ),
            (
                RenderOption::Alpha,
                vec![JsField::BigInt(Some(1)), JsField::Other],
            ),
            (
                RenderOption::Seed,
                vec![JsField::Text("1".into()), JsField::Other],
            ),
            (
                RenderOption::Background,
                vec![JsField::Number(1.0), JsField::Other],
            ),
            (
                RenderOption::ResizeInput,
                vec![JsField::Text("1".into()), JsField::Other],
            ),
            (
                RenderOption::OutputSize,
                vec![JsField::Text("1".into()), JsField::Other],
            ),
        ];
        for (option, values) in wrong {
            for value in values {
                let shown = format!("{value:?}");
                let error = read(vec![(option, value)]).expect_err("wrong type should fail");

                assert!(
                    matches!(error, ApproximateError::InvalidOption { option: o } if o == option),
                    "{option:?} = {shown}: {}",
                    js_message(&error)
                );
            }
        }
    }

    #[test]
    fn a_failing_read_stops_and_returns_its_error() {
        let mut read = Vec::new();
        let error = render_options(
            |option| {
                read.push(option);
                if option == RenderOption::Alpha {
                    Err("getter threw")
                } else {
                    Ok(JsField::Absent)
                }
            },
            |_| "invalid option",
        )
        .expect_err("a failing read should fail");

        assert_eq!(error, "getter threw");
        assert_eq!(
            read,
            [
                RenderOption::Count,
                RenderOption::Shape,
                RenderOption::Alpha
            ]
        );
    }
}
