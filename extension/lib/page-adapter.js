"use strict";

(() => {
  const PASS_PATH = "/.within.website/x/cmd/anubis/api/pass-challenge";
  const MAX_DIFFICULTY = 6;
  const PREFIX_RE = /^[0-9a-f]{128}$/;
  const ID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const HASH_RE = /^[0-9a-f]{64}$/;
  const NONCE_RE = /^0{44}[0-9]{8}$/;

  function jsonScript(documentObject, id, maxLength) {
    const element = documentObject.getElementById(id);
    if (!element || String(element.tagName).toUpperCase() !== "SCRIPT") {
      throw new Error(`missing ${id}`);
    }
    if (String(element.type).toLowerCase() !== "application/json") {
      throw new Error(`unexpected ${id} type`);
    }
    const text = element.textContent || "";
    if (text.length === 0 || text.length > maxLength) {
      throw new Error(`invalid ${id} size`);
    }
    return JSON.parse(text);
  }

  function sameOriginHttpUrl(value, pageUrl) {
    const page = new URL(pageUrl);
    const candidate = new URL(value, page);
    if (!/^https?:$/.test(page.protocol) || candidate.origin !== page.origin) {
      throw new Error("URL is not same-origin HTTP(S)");
    }
    if (candidate.username || candidate.password) {
      throw new Error("URL credentials are not allowed");
    }
    return candidate;
  }

  function passEndpoint(basePrefix, pageUrl) {
    if (
      typeof basePrefix !== "string" || basePrefix.length > 2048 ||
      (basePrefix !== "" && !basePrefix.startsWith("/")) ||
      // deno-lint-ignore no-control-regex -- control bytes are forbidden.
      /[?#\\\u0000-\u0020\u007f]/.test(basePrefix) ||
      basePrefix.includes("//")
    ) {
      throw new Error("invalid base prefix");
    }
    const pathSegments = basePrefix.split("/");
    for (const rawSegment of pathSegments) {
      let segment;
      try {
        segment = decodeURIComponent(rawSegment);
      } catch (_error) {
        throw new Error("invalid base prefix encoding");
      }
      if (segment === "." || segment === ".." || /[/\\]/.test(segment)) {
        throw new Error("invalid base prefix segment");
      }
    }
    const prefix = basePrefix.endsWith("/")
      ? basePrefix.slice(0, -1)
      : basePrefix;
    return sameOriginHttpUrl(`${prefix}${PASS_PATH}`, pageUrl);
  }

  function readChallengePage(documentObject, pageUrl) {
    try {
      const page = new URL(pageUrl);
      if (!/^https?:$/.test(page.protocol)) {
        return null;
      }

      const payload = jsonScript(documentObject, "anubis_challenge", 16 * 1024);
      const basePrefix = jsonScript(documentObject, "anubis_base_prefix", 4096);
      let publicUrl = null;
      const publicElement = documentObject.getElementById("anubis_public_url");
      if (publicElement) {
        publicUrl = jsonScript(documentObject, "anubis_public_url", 4096);
      }

      const rules = payload && payload.rules;
      const challenge = payload && payload.challenge;
      if (!rules || !challenge || !["fast", "slow"].includes(rules.algorithm)) {
        return null;
      }
      if (
        !Number.isInteger(rules.difficulty) ||
        rules.difficulty < 1 ||
        rules.difficulty > MAX_DIFFICULTY
      ) {
        return null;
      }
      if (
        typeof challenge.randomData !== "string" ||
        !PREFIX_RE.test(challenge.randomData)
      ) {
        return null;
      }
      if (typeof challenge.id !== "string" || !ID_RE.test(challenge.id)) {
        return null;
      }
      if (
        publicUrl !== null &&
        (typeof publicUrl !== "string" || publicUrl.length > 2048)
      ) {
        return null;
      }

      const endpoint = passEndpoint(basePrefix, page.href);
      return {
        algorithm: rules.algorithm,
        challengeId: challenge.id,
        difficulty: rules.difficulty,
        endpoint: endpoint.href,
        origin: page.origin,
        pageUrl: page.href,
        prefix: challenge.randomData,
        publicUrl,
      };
    } catch (_error) {
      return null;
    }
  }

  function safeRedirect(snapshot) {
    let candidate;
    if (snapshot.publicUrl === null) {
      candidate = "/";
    } else if (
      snapshot.publicUrl &&
      snapshot.pageUrl.startsWith(snapshot.publicUrl)
    ) {
      candidate = new URL(snapshot.pageUrl).searchParams.get("redir") || "/";
    } else {
      candidate = snapshot.pageUrl;
    }
    if (typeof candidate !== "string" || candidate.length > 4096) {
      return "/";
    }
    try {
      const redirect = new URL(candidate, snapshot.pageUrl);
      if (
        !/^https?:$/.test(redirect.protocol) ||
        redirect.username || redirect.password
      ) {
        return "/";
      }
      // Preserve the stock adapter's relative/absolute spelling. Anubis applies
      // its configured redirect-domain policy after the same-origin pass GET.
      return candidate;
    } catch (_error) {
      return "/";
    }
  }

  function validateSolutionShape(solution) {
    return Boolean(
      solution &&
        typeof solution === "object" &&
        typeof solution.nonce === "string" &&
        NONCE_RE.test(solution.nonce) &&
        typeof solution.hash === "string" &&
        HASH_RE.test(solution.hash),
    );
  }

  function hasLeadingZeroNibbles(hash, difficulty) {
    return hash.slice(0, difficulty) === "0".repeat(difficulty);
  }

  async function verifySolution(snapshot, solution, cryptoObject) {
    if (
      !snapshot || !validateSolutionShape(solution) ||
      !hasLeadingZeroNibbles(solution.hash, snapshot.difficulty)
    ) {
      return false;
    }
    const cryptoApi = cryptoObject || globalThis.crypto;
    if (!cryptoApi || !cryptoApi.subtle) {
      return false;
    }
    const bytes = new TextEncoder().encode(snapshot.prefix + solution.nonce);
    const digest = new Uint8Array(
      await cryptoApi.subtle.digest("SHA-256", bytes),
    );
    const expected = Array.from(
      digest,
      (value) => value.toString(16).padStart(2, "0"),
    ).join("");
    return expected === solution.hash;
  }

  function buildSubmissionUrl(snapshot, solution, elapsedMs, currentPageUrl) {
    if (!snapshot || !validateSolutionShape(solution)) {
      throw new Error("invalid solution");
    }
    const current = new URL(currentPageUrl);
    if (current.origin !== snapshot.origin) {
      throw new Error("page origin changed");
    }
    const endpoint = sameOriginHttpUrl(snapshot.endpoint, current.href);
    endpoint.search = "";
    endpoint.searchParams.set("id", snapshot.challengeId);
    endpoint.searchParams.set("response", solution.hash);
    endpoint.searchParams.set("nonce", solution.nonce);
    endpoint.searchParams.set("redir", safeRedirect(snapshot));
    endpoint.searchParams.set(
      "elapsedTime",
      String(Math.max(0, Math.min(60_000, Math.round(elapsedMs)))),
    );
    return endpoint.href;
  }

  function sameChallenge(left, right) {
    return Boolean(
      left && right &&
        left.origin === right.origin &&
        left.challengeId === right.challengeId &&
        left.prefix === right.prefix &&
        left.difficulty === right.difficulty &&
        left.algorithm === right.algorithm,
    );
  }

  globalThis.AnubisPageAdapter = {
    buildSubmissionUrl,
    readChallengePage,
    sameChallenge,
    verifySolution,
  };
})();
