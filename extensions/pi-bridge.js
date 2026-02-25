import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { makeTokenBucket, normalizeDelivery, safeChildPath, validateEnvelope } from "../lib/core.mjs";

const MAX_FILE_BYTES = 32 * 1024;
const PROCESSED_CACHE_MAX = 1024;

const MIN_MAX_TEXT = 256;
const MIN_QUEUE_DEPTH = 8;
const MIN_RATE_PER_MIN = 20;
const MIN_RATE_BURST = 4;
const MIN_INTERRUPT_RATE_PER_MIN = 20;
const MIN_INTERRUPT_RATE_BURST = 4;

function envNumber(name, fallback, min = 1) {
  const parsed = Number(process.env[name] ?? "");
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function ensureDirSecure(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function atomicWriteJson(filePath, data) {
  ensureDirSecure(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

function randomId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export default function (pi) {
  const baseDir = process.env.PI_BRIDGE_DIR?.trim() || path.join(os.homedir(), ".pi", "agent", "statusbridge");
  const registryDir = path.join(baseDir, "registry");
  const inboxRoot = path.join(baseDir, "inbox");
  const ackRoot = path.join(baseDir, "acks");
  const processingRoot = path.join(baseDir, "processing");

  const pidStr = String(process.pid);
  const inboxDir = path.join(inboxRoot, pidStr);
  const ackDir = path.join(ackRoot, pidStr);
  const processingDir = path.join(processingRoot, pidStr);
  const registryFile = path.join(registryDir, `${pidStr}.json`);

  const maxTextLength = envNumber("PI_BRIDGE_MAX_TEXT", 4000, MIN_MAX_TEXT);
  const maxSkewMs = envNumber("PI_BRIDGE_MAX_SKEW_MS", 120000, 1000);
  const heartbeatMs = envNumber("PI_BRIDGE_HEARTBEAT_MS", 2000, 250);
  const scanMs = envNumber("PI_BRIDGE_SCAN_MS", 750, 100);
  const refillPerMinute = envNumber("PI_BRIDGE_RATE_PER_MIN", 20, MIN_RATE_PER_MIN);
  const burst = envNumber("PI_BRIDGE_RATE_BURST", 6, MIN_RATE_BURST);
  const refillInterruptPerMinute = envNumber("PI_BRIDGE_INTERRUPT_RATE_PER_MIN", 20, MIN_INTERRUPT_RATE_PER_MIN);
  const burstInterrupt = envNumber("PI_BRIDGE_INTERRUPT_RATE_BURST", 4, MIN_INTERRUPT_RATE_BURST);
  const queueDepthLimit = envNumber("PI_BRIDGE_QUEUE_DEPTH", 64, MIN_QUEUE_DEPTH);

  ensureDirSecure(baseDir);
  ensureDirSecure(registryDir);
  ensureDirSecure(inboxRoot);
  ensureDirSecure(ackRoot);
  ensureDirSecure(processingRoot);
  ensureDirSecure(inboxDir);
  ensureDirSecure(ackDir);
  ensureDirSecure(processingDir);

  const normalLimiter = makeTokenBucket({ refillPerMinute, burst });
  const interruptLimiter = makeTokenBucket({ refillPerMinute: refillInterruptPerMinute, burst: burstInterrupt });
  const maxPerDrain = envNumber("PI_BRIDGE_MAX_PER_DRAIN", 8, 1);
  const processed = new Map();

  let heartbeat = undefined;
  let scanner = undefined;
  let watcher = undefined;
  let isDraining = false;
  let sessionId = "";
  let lastCtx = undefined;

  function rememberProcessed(id) {
    processed.set(id, Date.now());
    if (processed.size <= PROCESSED_CACHE_MAX) return;
    const first = processed.keys().next().value;
    if (first) processed.delete(first);
  }

  function writeAck(status, envelope, extra = {}) {
    const ack = {
      v: 1,
      id: envelope?.id || randomId(),
      pid: process.pid,
      status,
      at: Date.now(),
      messagePid: envelope?.pid,
      source: envelope?.source,
      delivery: envelope?.delivery,
      ...extra,
    };
    const ackFile = path.join(ackDir, `${ack.id}.json`);
    atomicWriteJson(ackFile, ack);
  }

  function publishRegistry() {
    const payload = {
      v: 1,
      pid: process.pid,
      ppid: process.ppid,
      startedAt: process.uptime ? Math.floor(Date.now() - process.uptime() * 1000) : Date.now(),
      updatedAt: Date.now(),
      sessionId,
      cwd: process.cwd(),
      capabilities: {
        queueing: true,
        steering: true,
      },
    };
    atomicWriteJson(registryFile, payload);
  }

  function moveToProcessing(fileName) {
    const src = path.join(inboxDir, fileName);
    const dst = path.join(processingDir, `${fileName}.${Date.now()}.processing`);
    if (!safeChildPath(inboxDir, src) || !safeChildPath(processingDir, dst)) return null;
    try {
      const st = fs.lstatSync(src);
      if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_FILE_BYTES) {
        safeUnlink(src);
        return null;
      }
      fs.renameSync(src, dst);
      return dst;
    } catch {
      return null;
    }
  }

  function readEnvelope(filePath) {
    try {
      if (!safeChildPath(processingDir, filePath)) return { ok: false, error: "invalid_path" };
      const text = fs.readFileSync(filePath, "utf8");
      return { ok: true, raw: JSON.parse(text) };
    } catch {
      return { ok: false, error: "invalid_json" };
    }
  }

  function sendToAgent(ctx, envelope) {
    const isIdle = Boolean(ctx?.isIdle?.());
    const delivery = normalizeDelivery(envelope.delivery, isIdle);

    const limiter = delivery.mode === "interrupt" ? interruptLimiter : normalLimiter;

    // Soft throttle only: never reject here. Queue depth + per-drain cap provide
    // DoS protection without surfacing bridge_rate_limited to users.
    limiter.allow(1);

    try {
      if (delivery.sendUserMessageOptions) {
        pi.sendUserMessage(envelope.text, delivery.sendUserMessageOptions);
      } else {
        pi.sendUserMessage(envelope.text);
      }
      return { ok: true, delivery };
    } catch (error) {
      const raw = error instanceof Error ? error.message : "send_failed";
      const lower = String(raw || "").toLowerCase();
      if (lower.includes("rate") && lower.includes("limit")) {
        return { ok: false, error: "pi_rate_limited", delivery };
      }
      return { ok: false, error: raw, delivery };
    }
  }

  function processOneFile(fileName, ctx) {
    const processingFile = moveToProcessing(fileName);
    if (!processingFile) return;

    const parsed = readEnvelope(processingFile);
    if (!parsed.ok) {
      writeAck("failed", { id: fileName, pid: process.pid, source: "unknown" }, { error: parsed.error });
      safeUnlink(processingFile);
      return;
    }

    const validated = validateEnvelope(parsed.raw, {
      maxTextLength,
      maxSkewMs,
      expectedPid: process.pid,
    });

    if (!validated.ok) {
      writeAck("failed", { id: parsed.raw?.id ?? fileName, pid: process.pid, source: parsed.raw?.source }, { error: validated.error });
      safeUnlink(processingFile);
      return;
    }

    const envelope = validated.value;
    if (processed.has(envelope.id)) {
      writeAck("duplicate", envelope, { error: "duplicate_id" });
      safeUnlink(processingFile);
      return;
    }

    const result = sendToAgent(ctx, envelope);
    if (!result.ok) {
      writeAck("failed", envelope, { error: result.error, resolvedMode: result.delivery?.mode });
      safeUnlink(processingFile);
      return;
    }

    rememberProcessed(envelope.id);
    writeAck("delivered", envelope, { resolvedMode: result.delivery.mode });
    safeUnlink(processingFile);
  }

  function drainInbox(ctx) {
    if (isDraining) return;
    isDraining = true;
    try {
      if (!ctx) return;
      const entries = fs.readdirSync(inboxDir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith(".json"))
        .map((d) => d.name)
        .sort();

      if (entries.length > queueDepthLimit) {
        const dropCount = entries.length - queueDepthLimit;
        for (const name of entries.slice(0, dropCount)) {
          const full = path.join(inboxDir, name);
          safeUnlink(full);
        }
      }

      const kept = entries.slice(-queueDepthLimit);
      const toProcess = kept.slice(0, maxPerDrain);

      for (const name of toProcess) {
        processOneFile(name, ctx);
      }
    } finally {
      isDraining = false;
    }
  }

  function startBackground() {
    publishRegistry();

    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(() => publishRegistry(), heartbeatMs);
    heartbeat.unref?.();

    if (scanner) clearInterval(scanner);
    scanner = setInterval(() => drainInbox(lastCtx), scanMs);
    scanner.unref?.();

    try {
      if (watcher) watcher.close();
      watcher = fs.watch(inboxDir, { persistent: false }, () => drainInbox(lastCtx));
    } catch {
      watcher = undefined;
    }
  }

  function stopBackground() {
    if (heartbeat) clearInterval(heartbeat);
    if (scanner) clearInterval(scanner);
    heartbeat = undefined;
    scanner = undefined;
    if (watcher) {
      watcher.close();
      watcher = undefined;
    }
  }

  pi.registerCommand("pi-bridge-status", {
    description: "Show pi-bridge directories and runtime settings",
    handler: async (_args, ctx) => {
      lastCtx = ctx;
      const msg = [
        `pi-bridge pid=${process.pid}`,
        `base=${baseDir}`,
        `inbox=${inboxDir}`,
        `acks=${ackDir}`,
        `maxText=${maxTextLength}`,
        `queueDepthLimit=${queueDepthLimit}`,
        `rate/min=${refillPerMinute} burst=${burst}`,
        `interruptRate/min=${refillInterruptPerMinute} burst=${burstInterrupt}`,
      ].join("\n");

      pi.sendMessage({ customType: "pi-bridge", content: msg, display: true });
      if (ctx.hasUI) ctx.ui.notify("pi-bridge status emitted", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    sessionId = ctx.sessionManager.getSessionId();
    startBackground();
    drainInbox(ctx);
  });

  pi.on("turn_start", async (_event, ctx) => {
    lastCtx = ctx;
    drainInbox(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    lastCtx = ctx;
    drainInbox(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    lastCtx = ctx;
    drainInbox(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopBackground();
    safeUnlink(registryFile);
  });
}
