// The calling worker of the single-threaded build. The glue import is static
// so that bundlers bundle it with its snippets and `.wasm` asset.
import * as glueModule from "../wasm/single/primeval.js?v=fast-1";
import { requestRunner, scope } from "./worker-common.js";
const glue = glueModule;
const run = requestRunner(glue);
scope.onmessage = ({ data }) => {
    void run(data);
};
// Its modules are loaded and it starts no other worker: the page can start the
// next call's worker.
scope.postMessage({ type: "started" });
