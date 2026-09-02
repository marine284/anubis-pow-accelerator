const module = WebAssembly.compileStreaming(
  fetch(chrome.runtime.getURL("sha256_wasm.wasm")),
);
const NONCES = 100_000_000;
const NTHREADS = navigator.hardwareConcurrency;
let job;

function workerReady(worker, wasm) {
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data?.status === "ready") resolve();
      else reject(new Error("worker initialization failed"));
    };
    worker.onerror = reject;
    worker.postMessage({ module: wasm, type: "init" });
  });
}

async function solve(request) {
  if (job) return { status: "error" };
  const state = {
    done: false,
    id: request.id,
    workers: [],
  };
  job = state;
  const started = performance.now();
  const result = new Promise((resolve) => state.resolve = resolve);
  const finish = (value) => {
    if (state.done) return;
    state.done = true;
    for (const worker of state.workers) worker.terminate();
    state.resolve(value);
  };
  state.finish = finish;

  try {
    if (
      !Number.isInteger(request.id) ||
      !Number.isInteger(request.difficulty) ||
      request.difficulty < 1 || request.difficulty > 6 ||
      typeof request.prefix !== "string" ||
      !/^[0-9a-f]{128}$/.test(request.prefix)
    ) {
      throw new Error("bad request");
    }
    const wasm = await Promise.race([module, result.then(() => null)]);
    if (!state.done) {
      state.workers = Array.from(
        { length: NTHREADS },
        () => new Worker("wasm-worker.js", { type: "module" }),
      );
      await Promise.race([
        Promise.all(state.workers.map((worker) => workerReady(worker, wasm))),
        result,
      ]);
    }
    if (!state.done) {
      let finished = 0;
      state.workers.forEach((worker, index) => {
        const start = Math.floor(index * NONCES / NTHREADS);
        const end = Math.floor((index + 1) * NONCES / NTHREADS);
        worker.onmessage = ({ data }) => {
          if (!data || data.id !== state.id) return;
          if (data.status === "solved") {
            finish({
              elapsedMs: performance.now() - started,
              hash: data.hash,
              nonce: data.nonce,
              status: "solved",
            });
          } else if (data.status === "exhausted") {
            if (++finished === state.workers.length) finish({ status: "exhausted" });
          } else {
            finish({ status: data.status === "cancelled" ? "cancelled" : "error" });
          }
        };
        worker.onerror = () => finish({ status: "error" });
        worker.postMessage({
          count: end - start,
          difficulty: request.difficulty,
          id: state.id,
          prefix: request.prefix,
          start,
          type: "solve",
        });
      });
    }
  } catch (_error) {
    finish({ status: "error" });
  }

  try {
    return await result;
  } finally {
    if (job === state) job = null;
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.target !== "wasm") return;
  if (message.type === "cancel") {
    if (job?.id === message.id) job.finish({ status: "cancelled" });
    return Promise.resolve({ status: "cancelled" });
  }
  if (message.type === "solve") return solve(message);
});
