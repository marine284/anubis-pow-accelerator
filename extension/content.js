"use strict";

(() => {
  const adapter = globalThis.AnubisPageAdapter;
  const PORT_NAME = "anubis-pow";
  const RELEASE_EVENT = "anubis-pow-release";
  const COMMIT_EVENT = "anubis-pow-commit";
  const PAGE_WATCHDOG_MS = 10_250;
  const DETECTION_WINDOW_MS = 5000;
  let attempted = false;

  function releaseStockSolver() {
    document.dispatchEvent(new CustomEvent(RELEASE_EVENT));
  }

  async function handleResponse(snapshot, startedAt, response) {
    if (!response || response.status !== "solved") {
      releaseStockSolver();
      return;
    }
    const solution = { hash: response.hash, nonce: response.nonce };
    try {
      if (!(await adapter.verifySolution(snapshot, solution))) {
        releaseStockSolver();
        return;
      }
      const current = adapter.readChallengePage(
        document,
        globalThis.location.href,
      );
      if (!adapter.sameChallenge(snapshot, current)) {
        releaseStockSolver();
        return;
      }
      const elapsedMs = Math.max(
        response.elapsedMs || 0,
        performance.now() - startedAt,
      );
      const target = adapter.buildSubmissionUrl(
        snapshot,
        solution,
        elapsedMs,
        globalThis.location.href,
      );
      document.dispatchEvent(new CustomEvent(COMMIT_EVENT));
      globalThis.location.replace(target);
    } catch (_error) {
      releaseStockSolver();
    }
  }

  function start() {
    if (attempted) {
      return;
    }
    const snapshot = adapter.readChallengePage(
      document,
      globalThis.location.href,
    );
    if (!snapshot) {
      return;
    }
    attempted = true;
    observer?.disconnect();
    const startedAt = performance.now();
    let settled = false;
    let relay;

    const finish = (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      try {
        relay?.disconnect();
      } catch (_error) { /* already closed */ }
      void handleResponse(snapshot, startedAt, response);
    };

    const watchdog = setTimeout(
      () => finish({ status: "timeout" }),
      PAGE_WATCHDOG_MS,
    );
    try {
      relay = chrome.runtime.connect({ name: PORT_NAME });
      relay.onMessage.addListener(finish);
      relay.onDisconnect.addListener(() => {
        if (!settled) finish({ status: "error" });
      });
      relay.postMessage({
        difficulty: snapshot.difficulty,
        prefix: snapshot.prefix,
      });
    } catch (_error) {
      finish({ status: "error" });
    }
  }

  if (!adapter) {
    releaseStockSolver();
    return;
  }
  const observer = new MutationObserver(start);
  observer.observe(document, { childList: true, subtree: true });
  start();
  setTimeout(() => observer?.disconnect(), DETECTION_WINDOW_MS);
})();
