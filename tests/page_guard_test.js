import "../extension/page-guard.js";

function assert(condition, message = "assertion failed") {
  if (!condition) throw new Error(message);
}

function script(value) {
  return {
    tagName: "SCRIPT",
    type: "application/json",
    textContent: JSON.stringify(value),
  };
}

class FakeDocument extends EventTarget {
  constructor(basePrefix = "/guard") {
    super();
    this.elements = {
      anubis_challenge: script({
        rules: { algorithm: "fast", difficulty: 6 },
        challenge: {
          id: "019a3c32-4560-7c5d-84e2-a9ec65d03f8b",
          randomData: "a".repeat(128),
        },
      }),
      anubis_base_prefix: script(basePrefix),
    };
  }

  getElementById(id) {
    return this.elements[id] || null;
  }
}

Deno.test("page guard eagerly constructs, queues, releases, commits, and preserves errors", () => {
  const timers = new Map();
  let nextTimer = 1;
  const instances = [];
  function FakeWorker(url) {
    if (url === "blob:bad") throw new Error("Worker constructor failure");
    this.url = url;
    this.messages = [];
    this.terminated = false;
    instances.push(this);
  }
  FakeWorker.prototype.postMessage = function postMessage(...args) {
    this.messages.push(args);
  };
  FakeWorker.prototype.terminate = function terminate() {
    this.terminated = true;
  };
  FakeWorker.prototype.addEventListener = function addEventListener() {};
  FakeWorker.prototype.removeEventListener = function removeEventListener() {};
  FakeWorker.prototype.dispatchEvent = function dispatchEvent() {
    return true;
  };

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {}
    disconnect() {}
  }

  const fakeWindow = { Worker: FakeWorker };
  const fakeDocument = new FakeDocument();
  globalThis.__installAnubisPageGuardForTest(
    fakeWindow,
    fakeDocument,
    FakeMutationObserver,
    (callback, delay) => {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    },
    (id) => timers.delete(id),
  );
  assert(
    fakeWindow.Worker !== FakeWorker,
    "supported page should install the gate",
  );

  let constructorThrew = false;
  try {
    new fakeWindow.Worker("blob:bad");
  } catch (_error) {
    constructorThrew = true;
  }
  assert(
    constructorThrew,
    "real Worker constructor errors must remain synchronous",
  );

  const worker = new fakeWindow.Worker("blob:good");
  assert(
    worker instanceof fakeWindow.Worker,
    "Worker instanceof contract must hold",
  );
  assert(
    instances.length === 1,
    "Blob worker must be constructed before URL revocation",
  );
  worker.postMessage({ challenge: true });
  assert(
    instances[0].messages.length === 0,
    "postMessage should be held during accelerated solve",
  );

  fakeDocument.dispatchEvent(new Event("anubis-pow-release"));
  assert(
    instances[0].messages.length === 1,
    "release should replay queued work immediately",
  );
  worker.postMessage({ later: true });
  assert(
    instances[0].messages.length === 2,
    "post-release messages should pass through",
  );

  fakeDocument.dispatchEvent(new Event("anubis-pow-commit"));
  assert(
    instances[0].terminated,
    "commit must terminate even an already-released stock worker",
  );
});

Deno.test("hostile base prefix never activates the page guard", () => {
  const fakeWorker = function FakeWorker() {};
  const fakeWindow = { Worker: fakeWorker };
  globalThis.__installAnubisPageGuardForTest(
    fakeWindow,
    new FakeDocument("https://evil.test"),
    class {
      observe() {}
      disconnect() {}
    },
    () => 1,
    () => {},
  );
  assert(fakeWindow.Worker === fakeWorker);
});
