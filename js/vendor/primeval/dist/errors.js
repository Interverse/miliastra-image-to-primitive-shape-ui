/** Base class of every error `approximate()` rejects with or `toDataUri()` throws. */
export class PrimevalError extends Error {
    /** The stable error code; branch on it or on the subclass, not on the message. */
    code;
    constructor(name, code, message, options) {
        super(message, options);
        this.name = name;
        this.code = code;
    }
}
/** An invalid option (`INVALID_OPTION`) or unusable input image (`INVALID_IMAGE`). */
export class ValidationError extends PrimevalError {
    /**
     * The invalid field, when it is `output` or a `render` option. The message
     * is then `` `${option} ${requirement}` ``.
     */
    option;
    /** What `option` accepts, e.g. `"must be an integer from 2 to 2048"`. */
    requirement;
    constructor(message, options) {
        super("ValidationError", options?.code ?? "INVALID_OPTION", message, options);
        if (options?.option !== undefined) {
            this.option = options.option;
            this.requirement = options.requirement;
        }
    }
}
/** The error for an invalid value of `option`: `` `${option} ${requirement}` ``. */
export function invalidOption(option, requirement) {
    return new ValidationError(`${option} ${requirement}`, { option, requirement });
}
/** The render was cancelled through `execution.signal` (`ABORTED`). */
export class AbortError extends PrimevalError {
    constructor(message, options) {
        super("AbortError", "ABORTED", message, options);
    }
}
/**
 * A failure valid input should not cause (`INTERNAL`): a native addon that
 * fails to load, an encoder or allocation failure, or a caught native panic.
 */
export class InternalError extends PrimevalError {
    constructor(message, options) {
        super("InternalError", "INTERNAL", message, options);
    }
}
/** The message of a thrown value: an `Error`'s message, or the value as a string. */
export function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * The `option` and `requirement` of a native invalid-option error, or none
 * when it names no option.
 */
export function optionFields(error) {
    return typeof error.option === "string"
        ? { option: error.option, requirement: String(error.requirement) }
        : {};
}
// Maps on the native `code` only, never on the message text. Errors without
// a known code pass through unchanged.
export function mapNativeError(error) {
    if (!(error instanceof Error)) {
        return error;
    }
    const native = error;
    const options = { cause: error };
    switch (native.code) {
        case "INVALID_OPTION":
        case "INVALID_IMAGE":
            return new ValidationError(error.message, {
                ...options,
                code: native.code,
                ...optionFields(native),
            });
        case "ABORTED":
            return new AbortError(error.message, options);
        case "INTERNAL":
            return new InternalError(error.message, options);
        default:
            return error;
    }
}
