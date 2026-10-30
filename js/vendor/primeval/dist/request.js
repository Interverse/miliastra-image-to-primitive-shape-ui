// Request normalization shared by the Node and browser entries.
//
// Type checks only: Rust owns the ranges and vocabularies. Only `undefined`
// means omitted.
import { AbortError, invalidOption, ValidationError } from "./errors.js";
function optionalObject(value, name) {
    if (value === undefined) {
        return {};
    }
    if (value === null || typeof value !== "object") {
        throw new ValidationError(`${name} must be an object`);
    }
    return value;
}
function normalizeInput(input) {
    // A Node `Buffer` is a `Uint8Array`.
    if (input instanceof Uint8Array) {
        return input;
    }
    throw new ValidationError("input must be a Uint8Array");
}
function field(fields, name, accepts, requirement) {
    const value = fields[name];
    if (value === undefined) {
        return undefined;
    }
    if (!accepts(value)) {
        throw invalidOption(name, requirement);
    }
    return value;
}
const isNumber = (value) => typeof value === "number";
const isString = (value) => typeof value === "string";
const isSeed = (value) => typeof value === "number" || typeof value === "bigint";
function normalizeRender(render) {
    const values = {
        count: field(render, "count", isNumber, "must be a number"),
        shape: field(render, "shape", isString, "must be a string"),
        // The type check shares Rust's wording; Rust checks the value.
        alpha: field(render, "alpha", (value) => isNumber(value) || isString(value), "must be auto or an integer 1..255"),
        seed: field(render, "seed", isSeed, "must be a number or a bigint"),
        background: field(render, "background", isString, "must be a string"),
        resizeInput: field(render, "resizeInput", isNumber, "must be a number"),
        outputSize: field(render, "outputSize", isNumber, "must be a number"),
    };
    // Omitted fields stay absent so Rust applies its defaults.
    return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}
/** Type-checks a request; throws `ValidationError` for a wrong type. */
export function normalizeRequest(request) {
    if (request === null || typeof request !== "object") {
        throw new ValidationError("request must be an object");
    }
    const fields = request;
    const input = normalizeInput(fields.input);
    const output = fields.output;
    if (!isString(output)) {
        throw invalidOption("output", "must be a string");
    }
    const render = normalizeRender(optionalObject(fields.render, "render"));
    const execution = optionalObject(fields.execution, "execution");
    const { onProgress, signal } = execution;
    if (onProgress !== undefined && typeof onProgress !== "function") {
        throw new ValidationError("execution.onProgress must be a function");
    }
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
        throw new ValidationError("execution.signal must be an AbortSignal");
    }
    return {
        input,
        output,
        render,
        onProgress: onProgress,
        signal,
    };
}
/** The `AbortError` for an aborted signal; its `cause` is `signal.reason`. */
export function abortError(signal) {
    return new AbortError("render aborted", { cause: signal.reason });
}
