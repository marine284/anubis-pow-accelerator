const encoder = new TextEncoder();
let wasm;

function solve(job) {
  if (!wasm) {
    postMessage({ id: job.id, status: "error" });
    return;
  }
  try {
    const input = new Uint8Array(wasm.memory.buffer, wasm.input(), 128);
    const encoded = encoder.encodeInto(job.prefix, input);
    if (encoded.read !== 128 || encoded.written !== 128) {
      throw new Error("bad prefix");
    }
    wasm.prepare();

    const nonce = wasm.search(job.start, job.count, job.difficulty);
    if (nonce >= 0) {
      if (wasm.hash_nonce(nonce) !== 1) {
        throw new Error("kernel rejected nonce");
      }
      const hash = new Uint8Array(wasm.memory.buffer, wasm.hash(), 32).toHex();
      postMessage({
        attempts: nonce - job.start + 1,
        hash,
        id: job.id,
        nonce: "0".repeat(44) + String(nonce).padStart(8, "0"),
        status: "solved",
      });
    } else if (nonce === -1) {
      postMessage({ attempts: job.count, id: job.id, status: "exhausted" });
    } else {
      throw new Error("kernel rejected range");
    }
  } catch (_error) {
    postMessage({ id: job.id, status: "error" });
  }
}

onmessage = ({ data }) => {
  if (!data || typeof data !== "object") {
    return;
  }
  if (data.type === "init") {
    try {
      wasm = new WebAssembly.Instance(data.module).exports;
      postMessage({ status: "ready" });
    } catch (_error) {
      postMessage({ status: "error" });
    }
  } else if (data.type === "solve") {
    solve(data);
  }
};
