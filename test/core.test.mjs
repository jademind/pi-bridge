import test from "node:test";
import assert from "node:assert/strict";
import { makeTokenBucket, normalizeDelivery, safeChildPath, validateEnvelope } from "../lib/core.mjs";

test("validateEnvelope accepts valid payload", () => {
  const now = Date.now();
  const res = validateEnvelope(
    {
      v: 1,
      id: "abc",
      pid: 123,
      text: "hello",
      source: "statusbar",
      createdAt: now,
      expiresAt: now + 5000,
      delivery: { mode: "interrupt" },
    },
    { expectedPid: 123, now },
  );

  assert.equal(res.ok, true);
  assert.equal(res.value.delivery.mode, "interrupt");
});

test("validateEnvelope rejects wrong pid", () => {
  const now = Date.now();
  const res = validateEnvelope(
    {
      v: 1,
      id: "abc",
      pid: 999,
      text: "hello",
      createdAt: now,
      expiresAt: now + 5000,
    },
    { expectedPid: 123, now },
  );

  assert.equal(res.ok, false);
  assert.equal(res.error, "pid_mismatch");
});

test("normalizeDelivery maps queued to followUp while busy", () => {
  const d = normalizeDelivery({ mode: "queued" }, false);
  assert.equal(d.mode, "queued");
  assert.deepEqual(d.sendUserMessageOptions, { deliverAs: "followUp" });
});

test("normalizeDelivery maps interrupt to steer while busy", () => {
  const d = normalizeDelivery({ mode: "interrupt" }, false);
  assert.equal(d.mode, "interrupt");
  assert.deepEqual(d.sendUserMessageOptions, { deliverAs: "steer" });
});

test("safeChildPath rejects traversal", () => {
  assert.equal(safeChildPath("/tmp/a", "/tmp/a/b/c"), true);
  assert.equal(safeChildPath("/tmp/a", "/tmp/other"), false);
});

test("token bucket throttles", () => {
  const bucket = makeTokenBucket({ refillPerMinute: 60, burst: 2 });
  const t = 1000;
  assert.equal(bucket.allow(1, t), true);
  assert.equal(bucket.allow(1, t), true);
  assert.equal(bucket.allow(1, t), false);
  assert.equal(bucket.allow(1, t + 1000), true);
});
