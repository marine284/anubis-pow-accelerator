const wasmPath = new URL("../extension/sha256_wasm.wasm", import.meta.url);
const module = await WebAssembly.compile(await Deno.readFile(wasmPath));
const encoder = new TextEncoder();

function kernel(prefix) {
  const exports = new WebAssembly.Instance(module).exports;
  encoder.encodeInto(
    prefix,
    new Uint8Array(exports.memory.buffer, exports.input(), 128),
  );
  exports.prepare();
  return exports;
}

function digest(exports) {
  return new Uint8Array(exports.memory.buffer, exports.hash(), 32).toHex();
}

async function reference(prefix, nonce) {
  const bytes = encoder.encode(
    prefix + "0".repeat(44) + String(nonce).padStart(8, "0"),
  );
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).toHex();
}

const prefix = "0123456789abcdef".repeat(8);

Deno.test("Wasm SIMD hashes fixed-width nonces exactly", async () => {
  const wasm = kernel(prefix);
  for (const nonce of [0, 1, 42, 9999, 10000, 8388607, 99999999]) {
    if (wasm.hash_nonce(nonce) !== 1) throw new Error("hash rejected nonce");
    const actual = digest(wasm);
    const expected = await reference(prefix, nonce);
    if (actual !== expected) {
      throw new Error(`${nonce}: ${actual} != ${expected}`);
    }
  }
});

Deno.test("Wasm SIMD search returns the first valid nonce", async () => {
  const wasm = kernel(prefix);
  const actual = wasm.search(0, 4096, 2);
  let expected = -1;
  for (let nonce = 0; nonce < 4096; ++nonce) {
    if ((await reference(prefix, nonce)).startsWith("00")) {
      expected = nonce;
      break;
    }
  }
  if (actual !== expected) throw new Error(`${actual} != ${expected}`);
  if (wasm.hash_nonce(actual) !== 1) throw new Error("hash rejected search result");
  if (digest(wasm) !== await reference(prefix, actual)) {
    throw new Error("search returned the wrong full digest");
  }
});

Deno.test("Wasm SIMD search rejects invalid ranges", () => {
  const wasm = kernel(prefix);
  for (const result of [
    wasm.search(0, 0, 1),
    wasm.search(100000000, 1, 1),
    wasm.search(99999999, 2, 1),
    wasm.search(0, 1, 7),
  ]) {
    if (result !== -2) throw new Error(`unexpected result ${result}`);
  }
});

Deno.test("Wasm worker initializes and solves through its message protocol", async () => {
  const worker = new Worker(
    new URL("../extension/wasm-worker.js", import.meta.url).href,
    { type: "module" },
  );
  const next = () =>
    new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => resolve(data);
      worker.onerror = (event) => reject(event.error || new Error(event.message));
    });
  try {
    let response = next();
    worker.postMessage({ module, type: "init" });
    if ((await response).status !== "ready") throw new Error("worker not ready");

    response = next();
    worker.postMessage({
      count: 4096,
      difficulty: 2,
      id: 1,
      prefix,
      start: 0,
      type: "solve",
    });
    const solved = await response;
    if (solved.status !== "solved") throw new Error(`worker ${solved.status}`);
    if (solved.hash !== await reference(prefix, Number(solved.nonce))) {
      throw new Error("worker returned the wrong digest");
    }
  } finally {
    worker.terminate();
  }
});
