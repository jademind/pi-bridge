import path from "node:path";

export const VALID_MODES = new Set(["queued", "interrupt"]);

export function parseTime(input) {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input === "string" && input.trim()) {
    const n = Number(input);
    if (Number.isFinite(n)) return n;
    const d = Date.parse(input);
    if (Number.isFinite(d)) return d;
  }
  return NaN;
}

export function nowMs() {
  return Date.now();
}

export function safeChildPath(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

export function normalizeDelivery(delivery, isIdle) {
  const mode = delivery?.mode === "interrupt" ? "interrupt" : "queued";

  if (isIdle) {
    return { mode, sendUserMessageOptions: undefined };
  }

  if (mode === "interrupt") {
    return { mode, sendUserMessageOptions: { deliverAs: "steer" } };
  }

  return { mode, sendUserMessageOptions: { deliverAs: "followUp" } };
}

export function validateEnvelope(raw, opts = {}) {
  const maxTextLength = Number.isFinite(opts.maxTextLength) ? opts.maxTextLength : 4000;
  const maxSkewMs = Number.isFinite(opts.maxSkewMs) ? opts.maxSkewMs : 60_000;
  const now = Number.isFinite(opts.now) ? opts.now : nowMs();
  const expectedPid = Number.isFinite(opts.expectedPid) ? opts.expectedPid : undefined;

  if (!raw || typeof raw !== "object") return { ok: false, error: "invalid_json" };

  const v = raw.v;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const pid = Number(raw.pid);
  const text = typeof raw.text === "string" ? raw.text.replace(/\r\n?/g, "\n").trim() : "";
  const source = typeof raw.source === "string" ? raw.source.trim() : "unknown";
  const createdAt = parseTime(raw.createdAt);
  const expiresAt = raw.expiresAt == null ? createdAt + maxSkewMs : parseTime(raw.expiresAt);

  if (v !== 1) return { ok: false, error: "unsupported_version" };
  if (!id || id.length > 128) return { ok: false, error: "invalid_id" };
  if (!Number.isFinite(pid) || pid <= 0) return { ok: false, error: "invalid_pid" };
  if (expectedPid != null && pid !== expectedPid) return { ok: false, error: "pid_mismatch" };
  if (!text) return { ok: false, error: "empty_text" };
  if (text.length > maxTextLength) return { ok: false, error: "text_too_long" };
  if (!Number.isFinite(createdAt)) return { ok: false, error: "invalid_created_at" };
  if (!Number.isFinite(expiresAt)) return { ok: false, error: "invalid_expires_at" };
  if (expiresAt < now) return { ok: false, error: "expired" };

  const rawMode = raw.delivery?.mode;
  const mode = VALID_MODES.has(rawMode) ? rawMode : "queued";

  return {
    ok: true,
    value: {
      v,
      id,
      pid,
      text,
      source: source || "unknown",
      createdAt,
      expiresAt,
      delivery: {
        mode,
        channel: "steer",
        triggerTurn: true,
      },
      meta: raw.meta && typeof raw.meta === "object" ? raw.meta : undefined,
    },
  };
}

export function makeTokenBucket({ refillPerMinute = 12, burst = 4 } = {}) {
  const ratePerMs = Math.max(1, refillPerMinute) / 60_000;
  const capacity = Math.max(1, burst);
  let tokens = capacity;
  let last = nowMs();

  return {
    allow(cost = 1, now = nowMs()) {
      const delta = Math.max(0, now - last);
      last = now;
      tokens = Math.min(capacity, tokens + delta * ratePerMs);
      if (tokens >= cost) {
        tokens -= cost;
        return true;
      }
      return false;
    },
  };
}
