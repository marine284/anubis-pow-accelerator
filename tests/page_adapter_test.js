import "../extension/lib/page-adapter.js";

const adapter = globalThis.AnubisPageAdapter;
const nonce42 = "0".repeat(44) + "00000042";

function assert(condition, message = "assertion failed") {
  if (!condition) throw new Error(message);
}

function assertEquals(actual, expected) {
  if (actual !== expected) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function script(value) {
  return {
    tagName: "SCRIPT",
    type: "application/json",
    textContent: JSON.stringify(value),
  };
}

function documentFor(overrides = {}) {
  const values = {
    anubis_challenge: script({
      rules: { algorithm: "fast", difficulty: 1 },
      challenge: {
        id: "019a3c32-4560-7c5d-84e2-a9ec65d03f8b",
        randomData: "a".repeat(128),
      },
    }),
    anubis_base_prefix: script("/guard"),
    anubis_public_url: script(null),
    ...overrides,
  };
  return { getElementById: (id) => values[id] || null };
}

Deno.test("reads a supported current Anubis challenge", () => {
  const snapshot = adapter.readChallengePage(
    documentFor(),
    "https://example.test/guarded?x=1",
  );
  assert(snapshot);
  assertEquals(snapshot.difficulty, 1);
  assertEquals(
    snapshot.endpoint,
    "https://example.test/guard/.within.website/x/cmd/anubis/api/pass-challenge",
  );
});

Deno.test("rejects hostile base prefixes and noncanonical challenge IDs", () => {
  for (
    const basePrefix of [
      "https://evil.test/x",
      "/a/../b",
      "/%2e%2e/b",
      "/a?b",
      "/a\\b",
      "/a//b",
      "/a b",
    ]
  ) {
    const snapshot = adapter.readChallengePage(
      documentFor({ anubis_base_prefix: script(basePrefix) }),
      "https://example.test/",
    );
    assertEquals(snapshot, null);
  }
  const badId = documentFor({
    anubis_challenge: script({
      rules: { algorithm: "fast", difficulty: 1 },
      challenge: { id: "not-a-uuid", randomData: "a".repeat(128) },
    }),
  });
  assertEquals(adapter.readChallengePage(badId, "https://example.test/"), null);
});

Deno.test("unsafe redirect schemes and credentials fall back to root", () => {
  for (
    const redir of ["javascript:alert(1)", "https://user:pass@public.example/"]
  ) {
    const pageUrl = `https://example.test/challenge?redir=${
      encodeURIComponent(redir)
    }`;
    const snapshot = adapter.readChallengePage(
      documentFor({ anubis_public_url: script("https://example.test/") }),
      pageUrl,
    );
    const target = new URL(adapter.buildSubmissionUrl(
      snapshot,
      { nonce: nonce42, hash: "0".repeat(64) },
      10,
      pageUrl,
    ));
    assertEquals(target.searchParams.get("redir"), "/");
  }
});

Deno.test("submission preserves fixed-width nonce and stock HTTP redirect spelling", () => {
  const pageUrl =
    "https://example.test/challenge?redir=https%3A%2F%2Fpublic.example%2Fdone";
  const snapshot = adapter.readChallengePage(
    documentFor({ anubis_public_url: script("https://example.test/") }),
    pageUrl,
  );
  const target = new URL(adapter.buildSubmissionUrl(
    snapshot,
    { nonce: nonce42, hash: "0".repeat(64) },
    12.6,
    pageUrl,
  ));
  assertEquals(target.origin, "https://example.test");
  assertEquals(target.searchParams.get("nonce"), nonce42);
  assertEquals(target.searchParams.get("redir"), "https://public.example/done");
  assertEquals(target.searchParams.get("elapsedTime"), "13");
});

Deno.test("verifies SHA-256 against the exact nonce string", async () => {
  const snapshot = adapter.readChallengePage(
    documentFor(),
    "https://example.test/",
  );
  let solution;
  for (let value = 0; value < 256; ++value) {
    const nonce = "0".repeat(44) + String(value).padStart(8, "0");
    const bytes = new TextEncoder().encode(snapshot.prefix + nonce);
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes),
    ).toHex();
    if (hash.startsWith("0")) {
      solution = { hash, nonce };
      break;
    }
  }
  assert(solution, "expected a deterministic difficulty-1 solution");
  assert(await adapter.verifySolution(snapshot, solution));
  assert(
    !(await adapter.verifySolution(snapshot, {
      ...solution,
      nonce: solution.nonce.slice(1),
    })),
  );
});
