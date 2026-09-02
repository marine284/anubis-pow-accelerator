export const PORT_NAME = "anubis-pow";
export const WATCHDOG_MS = 10_000;

const PREFIX_RE = /^[0-9a-f]{128}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const NONCE_RE = /^0{44}[0-9]{8}$/;

export function validateRelayRequest(message, sender, runtimeId) {
  if (
    !message || typeof message !== "object" || Array.isArray(message) ||
    typeof message.prefix !== "string" || !PREFIX_RE.test(message.prefix) ||
    !Number.isInteger(message.difficulty) ||
    message.difficulty < 1 || message.difficulty > 6
  ) {
    throw new Error("bad_request");
  }
  if (
    !sender || sender.id !== runtimeId || !sender.tab ||
    !Number.isInteger(sender.tab.id) || sender.frameId !== 0
  ) {
    throw new Error("bad_sender");
  }
  const senderUrl = new URL(sender.url || "");
  if (!/^https?:$/.test(senderUrl.protocol)) throw new Error("bad_origin");
  return {
    difficulty: message.difficulty,
    documentId: typeof sender.documentId === "string" ? sender.documentId : "",
    pageUrl: senderUrl.href,
    prefix: message.prefix,
    tabId: sender.tab.id,
  };
}

export function validateSolverResponse(message) {
  if (
    !message || typeof message !== "object" || Array.isArray(message) ||
    !["solved", "exhausted", "cancelled", "error"].includes(message.status)
  ) {
    throw new Error("bad_solver_response");
  }
  if (message.status !== "solved") return { status: message.status };
  if (
    typeof message.nonce !== "string" || !NONCE_RE.test(message.nonce) ||
    typeof message.hash !== "string" || !HASH_RE.test(message.hash) ||
    !Number.isFinite(message.elapsedMs) || message.elapsedMs < 0
  ) {
    throw new Error("bad_solution");
  }
  return {
    elapsedMs: Math.min(60_000, message.elapsedMs),
    hash: message.hash,
    nonce: message.nonce,
    status: "solved",
  };
}
