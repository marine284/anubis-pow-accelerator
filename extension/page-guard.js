"use strict";

// This script runs in MAIN world. It delays only Worker instances created on a
// recognized Anubis PoW page. Every queued call is released after a hard 10.5 s
// ceiling, even if the isolated extension world or service worker disappears.
((root) => {
  function installPageGuard(
    window,
    document,
    MutationObserver,
    setTimer,
    clearTimer,
  ) {
    const RELEASE_EVENT = "anubis-pow-release";
    const COMMIT_EVENT = "anubis-pow-commit";
    const HARD_RELEASE_MS = 10_500;
    const DETECTION_WINDOW_MS = 5000;
    const PREFIX_RE = /^[0-9a-f]{128}$/;
    const ID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const RealWorker = window.Worker;
    let done = false;
    let holding = false;
    let workers = [];
    let releaseTimer;

    function supportedChallenge() {
      const element = document.getElementById("anubis_challenge");
      if (
        !element || String(element.tagName).toUpperCase() !== "SCRIPT" ||
        String(element.type).toLowerCase() !== "application/json" ||
        !element.textContent || element.textContent.length > 16 * 1024
      ) {
        return false;
      }
      try {
        const value = JSON.parse(element.textContent || "");
        const algorithm = value && value.rules && value.rules.algorithm;
        const difficulty = value && value.rules && value.rules.difficulty;
        const prefix = value && value.challenge && value.challenge.randomData;
        const challengeId = value && value.challenge && value.challenge.id;
        const baseElement = document.getElementById("anubis_base_prefix");
        if (
          !baseElement ||
          String(baseElement.tagName).toUpperCase() !== "SCRIPT" ||
          String(baseElement.type).toLowerCase() !== "application/json" ||
          !baseElement.textContent || baseElement.textContent.length > 4096
        ) {
          return false;
        }
        const basePrefix = JSON.parse(baseElement.textContent || "");
        const publicElement = document.getElementById("anubis_public_url");
        let publicUrl = null;
        if (publicElement) {
          if (
            String(publicElement.tagName).toUpperCase() !== "SCRIPT" ||
            String(publicElement.type).toLowerCase() !== "application/json" ||
            !publicElement.textContent ||
            publicElement.textContent.length > 4096
          ) {
            return false;
          }
          publicUrl = JSON.parse(publicElement.textContent);
        }
        return ["fast", "slow"].includes(algorithm) &&
          Number.isInteger(difficulty) && difficulty >= 1 && difficulty <= 6 &&
          typeof prefix === "string" && PREFIX_RE.test(prefix) &&
          typeof challengeId === "string" && ID_RE.test(challengeId) &&
          validBasePrefix(basePrefix) &&
          (publicUrl === null ||
            (typeof publicUrl === "string" && publicUrl.length <= 2048));
      } catch (_error) {
        return false;
      }
    }

    function validBasePrefix(basePrefix) {
      if (
        typeof basePrefix !== "string" || basePrefix.length > 2048 ||
        (basePrefix !== "" && !basePrefix.startsWith("/")) ||
        // deno-lint-ignore no-control-regex -- control bytes are forbidden.
        /[?#\\\u0000-\u0020\u007f]/.test(basePrefix) ||
        basePrefix.includes("//")
      ) {
        return false;
      }
      try {
        return basePrefix.split("/").every((rawSegment) => {
          const segment = decodeURIComponent(rawSegment);
          return segment !== "." && segment !== ".." && !/[/\\]/.test(segment);
        });
      } catch (_error) {
        return false;
      }
    }

    class DeferredWorker {
      constructor(args) {
        // Construct eagerly so a Blob worker URL remains valid after Anubis
        // revokes it. Only postMessage is delayed, so constructor failures retain
        // the stock synchronous behavior and cannot be swallowed at release time.
        this.actual = Reflect.construct(RealWorker, args);
        this.terminated = false;
        this.started = false;
        this.messages = [];
      }

      start() {
        if (this.terminated || this.started) return;
        this.started = true;
        for (const args of this.messages) {
          this.actual.postMessage(...args);
        }
        this.messages = [];
      }

      postMessage(...args) {
        if (this.terminated) {
          return;
        }
        if (this.started) this.actual.postMessage(...args);
        else this.messages.push(args);
      }

      terminate() {
        this.terminated = true;
        this.messages = [];
        this.actual.terminate();
      }

      addEventListener(type, listener, options) {
        this.actual.addEventListener(type, listener, options);
      }

      removeEventListener(type, listener, options) {
        this.actual.removeEventListener(type, listener, options);
      }

      dispatchEvent(event) {
        return this.actual.dispatchEvent(event);
      }

      get onerror() {
        return this.actual.onerror;
      }
      set onerror(value) {
        this.actual.onerror = value;
      }

      get onmessage() {
        return this.actual.onmessage;
      }
      set onmessage(value) {
        this.actual.onmessage = value;
      }

      get onmessageerror() {
        return this.actual.onmessageerror;
      }
      set onmessageerror(value) {
        this.actual.onmessageerror = value;
      }
    }
    Object.setPrototypeOf(DeferredWorker.prototype, RealWorker.prototype);

    function GatedWorker(...args) {
      if (!new.target) {
        throw new TypeError("Worker constructor requires 'new'");
      }
      if (!holding) {
        return Reflect.construct(RealWorker, args);
      }
      const worker = new DeferredWorker(args);
      workers.push(worker);
      return worker;
    }

    Object.setPrototypeOf(GatedWorker, RealWorker);
    Object.defineProperty(GatedWorker, "prototype", {
      value: RealWorker.prototype,
    });

    function ungate() {
      done = true;
      holding = false;
      clearTimer(releaseTimer);
      if (window.Worker === GatedWorker) {
        window.Worker = RealWorker;
      }
    }

    function release() {
      ungate();
      for (const worker of workers) worker.start();
    }

    function commit() {
      ungate();
      for (const worker of workers) worker.terminate();
      workers = [];
    }

    function activate() {
      if (
        done ||
        typeof RealWorker !== "function" ||
        !supportedChallenge()
      ) {
        return;
      }
      done = true;
      holding = true;
      observer?.disconnect();
      try {
        window.Worker = GatedWorker;
      } catch (_error) {
        release();
        return;
      }
      releaseTimer = setTimer(release, HARD_RELEASE_MS);
    }

    document.addEventListener(RELEASE_EVENT, release, { once: true });
    document.addEventListener(COMMIT_EVENT, commit, { once: true });
    const observer = new MutationObserver(activate);
    observer.observe(document, { childList: true, subtree: true });
    activate();
    setTimer(() => observer?.disconnect(), DETECTION_WINDOW_MS);
  }

  // Deno loads this file as a module for dependency-free unit tests. Chrome's
  // MAIN world has no Deno global, so the test hook is never exposed to pages.
  if (typeof root.Deno === "object") {
    root.__installAnubisPageGuardForTest = installPageGuard;
  }
  if (root.window && root.document && root.MutationObserver) {
    installPageGuard(
      root.window,
      root.document,
      root.MutationObserver,
      root.setTimeout.bind(root),
      root.clearTimeout.bind(root),
    );
  }
})(globalThis);
