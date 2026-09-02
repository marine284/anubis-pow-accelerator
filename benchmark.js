const deno = globalThis.Deno;
const query = globalThis.location
  ? new URL(globalThis.location.href).searchParams
  : null;
const attempts = Number(deno ? deno.args[0] || 8388608 : query.get("attempts") || 8388608);
const NTHREADS = navigator.hardwareConcurrency;
if (
  !Number.isSafeInteger(attempts) || attempts < NTHREADS ||
  attempts > 100000000
) {
  throw new Error("usage: deno run --allow-read benchmark.js [attempts]");
}

const module = deno
  ? await WebAssembly.compile(await deno.readFile(
    new URL("./extension/sha256_wasm.wasm", import.meta.url),
  ))
  : await WebAssembly.compileStreaming(
    fetch(new URL("./extension/sha256_wasm.wasm", import.meta.url)),
  );
const prefix = "0123456789abcdef".repeat(8);
const workers = Array.from({ length: NTHREADS }, () =>
  new Worker(new URL("./extension/wasm-worker.js", import.meta.url).href, {
    type: "module",
  })
);

function wait(worker, accept) {
  return new Promise((resolve, reject) => {
    const message = ({ data }) => {
      if (!accept(data)) return;
      worker.removeEventListener("message", message);
      worker.removeEventListener("error", error);
      resolve(data);
    };
    const error = (event) => {
      worker.removeEventListener("message", message);
      worker.removeEventListener("error", error);
      reject(event.error || new Error(event.message));
    };
    worker.addEventListener("message", message);
    worker.addEventListener("error", error);
  });
}

async function run(id, count) {
  const jobs = workers.map((worker, index) => {
    const start = Math.floor(index * count / NTHREADS);
    const end = Math.floor((index + 1) * count / NTHREADS);
    const result = wait(worker, (data) => data.id === id);
    worker.postMessage({
      count: end - start,
      difficulty: 0,
      id,
      prefix,
      start,
      type: "solve",
    });
    return result;
  });
  return Promise.all(jobs);
}

try {
  const ready = workers.map((worker) => wait(worker, (data) => data.status));
  for (const worker of workers) worker.postMessage({ module, type: "init" });
  const initialized = await Promise.all(ready);
  if (initialized.some((result) => result.status !== "ready")) {
    throw new Error("worker initialization failed");
  }

  await run(1, 524288);
  const started = performance.now();
  const results = await run(2, attempts);
  const elapsedMs = performance.now() - started;
  if (results.some((result) => result.status !== "exhausted")) {
    throw new Error("benchmark worker failed");
  }

  const direct = new WebAssembly.Instance(module).exports;
  new TextEncoder().encodeInto(
    prefix,
    new Uint8Array(direct.memory.buffer, direct.input(), 128),
  );
  direct.prepare();
  direct.hash_nonce(attempts - 1);
  const checksum = new Uint8Array(
    direct.memory.buffer,
    direct.hash(),
    32,
  ).toHex();
  const hashesPerSecond = attempts / (elapsedMs / 1000);
  const meanMs = 16777216 / hashesPerSecond * 1000;
  const medianMs = Math.log(2) * 16777216 / hashesPerSecond * 1000;
  const p95Ms = -Math.log(0.05) * 16777216 / hashesPerSecond * 1000;

  const lines = [
    "Anubis Wasm SIMD deterministic benchmark",
    "kernel:           wasm-simd-4way",
    `workers:          ${NTHREADS}`,
    `attempts:         ${attempts}`,
    `elapsed:          ${elapsedMs.toFixed(3)} ms`,
    `throughput:       ${(hashesPerSecond / 1e6).toFixed(3)} MH/s`,
    `difficulty-6 mean ${meanMs.toFixed(3)} ms`,
    `difficulty-6 p50: ${medianMs.toFixed(3)} ms`,
    `difficulty-6 p95: ${p95Ms.toFixed(3)} ms`,
    `under-1s target:  ${meanMs < 1000 ? "PASS" : "MISS"} (mean)`,
    `checksum:         ${checksum}`,
  ];
  console.log(lines.join("\n"));
  if (globalThis.document) {
    document.querySelector("pre").textContent = lines.join("\n");
    document.title = "done";
  }
} finally {
  for (const worker of workers) worker.terminate();
}
