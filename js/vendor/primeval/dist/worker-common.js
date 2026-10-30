// Shared calling-worker logic: initialize the instance, panic hook and pool
// once, then run one task per message. Only successful workers may be reused.
import { messageOf, optionFields } from "./errors.js";
export const scope = globalThis;
const post = (message, transfer = []) => scope.postMessage(message, transfer);
/** A thrown value as plain data; without a stable code it is internal. */
function workerError(error) {
    const fields = (typeof error === "object" && error !== null ? error : {});
    return {
        code: typeof fields.code === "string" ? fields.code : "INTERNAL",
        message: messageOf(error),
        ...optionFields(fields),
    };
}
/** Initializes once per calling worker, then runs each message's task. */
export function requestRunner(glue, startPool) {
    let ready;
    // Only lifetime data is captured by the panic reporter, never a task's input.
    const initialize = async (module, channel) => {
        await glue.default({ module_or_path: module });
        // Before the pool starts, so the hook covers every thread.
        glue.setPanicReporter(channel, (message) => post({ type: "error", error: { code: "INTERNAL", message } }));
        await startPool?.(module);
    };
    return async (request) => {
        if (request.type === "init") {
            ready = initialize(request.module, request.channel);
            // The following run reports initialization failures after awaiting it.
            ready.catch(() => undefined);
            return;
        }
        try {
            await ready;
        }
        catch (error) {
            post({
                type: "error",
                error: {
                    code: "INTERNAL",
                    message: `could not start the WebAssembly module: ${messageOf(error)}`,
                },
            });
            return;
        }
        const { task } = request;
        try {
            if (task.kind === "panic") {
                glue.__panicForTests(task.site === "pool");
                throw new Error("the test panic did not panic");
            }
            const result = glue.approximate(task.input, task.output, task.render, request.progress ? (info) => post({ type: "progress", info }) : undefined);
            post({ type: "result", result }, [result.data.buffer]);
        }
        catch (error) {
            // The panic hook's error precedes this one on the same port.
            post({ type: "error", error: workerError(error) });
        }
    };
}
