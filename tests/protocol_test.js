import {
  validateRelayRequest,
  validateSolverResponse,
} from "../extension/lib/protocol.mjs";

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

const relayMessage = {
  difficulty: 6,
  prefix: "a".repeat(128),
};

const sender = {
  id: "extension-id",
  documentId: "document-id",
  frameId: 0,
  tab: { id: 7 },
  url: "https://example.test/challenge",
};

Deno.test("validates a relay request and its sender", () => {
  const relay = validateRelayRequest(relayMessage, sender, "extension-id");
  assertEquals(relay.prefix, relayMessage.prefix);
  assertEquals(relay.difficulty, 6);
  assertEquals(relay.tabId, 7);
});

Deno.test("rejects a foreign extension, subframe, and non-web page", () => {
  for (
    const badSender of [
      { ...sender, frameId: 2 },
      { ...sender, url: "file:///challenge" },
      { ...sender, id: "other-extension" },
    ]
  ) {
    let threw = false;
    try {
      validateRelayRequest(relayMessage, badSender, "extension-id");
    } catch (_error) {
      threw = true;
    }
    assert(threw);
  }
});

Deno.test("solver response keeps nonce as opaque decimal text", () => {
  const nonce = "0".repeat(44) + "00000042";
  const response = validateSolverResponse({
    status: "solved",
    nonce,
    hash: "0".repeat(64),
    elapsedMs: 23.5,
  });
  assertEquals(response.nonce, nonce);
});
