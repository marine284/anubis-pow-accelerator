import {
  PORT_NAME,
  validateRelayRequest,
  validateSolverResponse,
  WATCHDOG_MS,
} from "./lib/protocol.mjs";

const activeDocuments = new Set();
let creatingOffscreen;
let nextId = 0;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url],
  });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      justification: "Run bounded WebAssembly proof-of-work workers",
      reasons: ["WORKERS"],
      url: "offscreen.html",
    }).finally(() => creatingOffscreen = null);
  }
  await creatingOffscreen;
}

function solve(relay) {
  const id = ++nextId;
  let sent = false;
  let settled = false;
  let resolvePromise;
  const promise = new Promise((resolve) => resolvePromise = resolve);
  const finish = (result, cancel = false) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    if (cancel && sent) {
      void chrome.runtime.sendMessage({ id, target: "wasm", type: "cancel" })
        .catch(() => {});
    }
    resolvePromise(result);
  };
  const watchdog = setTimeout(
    () => finish({ status: "timeout" }, true),
    WATCHDOG_MS,
  );

  void (async () => {
    try {
      await ensureOffscreen();
      if (settled) return;
      sent = true;
      const result = await chrome.runtime.sendMessage({
        difficulty: relay.difficulty,
        id,
        prefix: relay.prefix,
        target: "wasm",
        type: "solve",
      });
      if (!settled) finish(validateSolverResponse(result));
    } catch (_error) {
      finish({ status: "error" }, true);
    }
  })();
  return { cancel: () => finish({ status: "cancelled" }, true), promise };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  let used = false;
  let operation;
  let key;

  const reply = (message) => {
    try {
      port.postMessage(message);
    } catch (_error) { /* page navigated */ }
  };

  port.onMessage.addListener((message) => {
    if (used) {
      reply({ status: "error" });
      port.disconnect();
      return;
    }
    used = true;
    let relay;
    try {
      relay = validateRelayRequest(message, port.sender, chrome.runtime.id);
      key = `${relay.tabId}:${relay.documentId || relay.pageUrl}`;
      if (activeDocuments.has(key)) throw new Error("duplicate");
      activeDocuments.add(key);
    } catch (_error) {
      reply({ status: "unsupported" });
      port.disconnect();
      return;
    }

    operation = solve(relay);
    void operation.promise.then((result) => {
      if (key) activeDocuments.delete(key);
      reply(result);
    });
  });

  port.onDisconnect.addListener(() => {
    operation?.cancel();
    if (key) activeDocuments.delete(key);
  });
});
