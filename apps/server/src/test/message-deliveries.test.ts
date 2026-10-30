import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers.js";
import { registerSession } from "../core/sessions.js";
import { askSession, getMessage, listMessages, checkInbox } from "../core/messages.js";
import { askAndMaybeWake, retryMessageDelivery } from "../core/ask.js";
import { setAutoWake } from "../core/app-settings.js";

function fixture() {
  const fixture = makeDb();
  setAutoWake(fixture.db, false);
  for (const id of ["sender", "target", "other", "successor"]) {
    registerSession(fixture.db, { id, name: id });
  }
  return fixture;
}

test("asks persist queued wake attempts without changing the read lifecycle", () => {
  const { db, cleanup } = fixture();
  try {
    const { message } = askAndMaybeWake(db, {
      from_session: "sender",
      to_session: "target",
      question: "hello",
    });
    assert.equal(message.status, "pending");
    assert.equal(message.delivery?.state, "queued");
    assert.equal(message.delivery?.attempts, 1);
    assert.equal(listMessages(db)[0].delivery?.state, "queued");
  } finally {
    cleanup();
  }
});

test("retry reuses the pending message and records explicit wake failure", () => {
  const { db, cleanup } = fixture();
  try {
    const message = askSession(db, {
      from_session: "sender",
      to_session: "target",
      question: "hello",
    });
    const result = retryMessageDelivery(db, message.id, "sender", () => ({
      woke: false,
      reason: "refused",
      disposition: "failed",
    }));
    assert.equal(result.message.id, message.id);
    assert.equal(result.message.delivery?.state, "failed");
    assert.equal(result.message.delivery?.attempts, 1);
    assert.equal(listMessages(db).length, 1);
    assert.equal(getMessage(db, message.id)?.status, "pending");
  } finally {
    cleanup();
  }
});

test("retry enforces actor and lifecycle, and addresses the current forwarded recipient", () => {
  const { db, cleanup } = fixture();
  try {
    const message = askSession(db, {
      from_session: "sender",
      to_session: "target",
      question: "hello",
    });
    assert.throws(() => retryMessageDelivery(db, message.id, "other"), { statusCode: 403 });
    assert.throws(() => retryMessageDelivery(db, 99999, "sender"), { statusCode: 404 });
    db.prepare("UPDATE messages SET to_session = 'successor' WHERE id = ?").run(message.id);
    let recipient = "";
    retryMessageDelivery(db, message.id, "successor", (_db, id) => {
      recipient = id;
      return { woke: true };
    });
    assert.equal(recipient, "successor");
    checkInbox(db, "successor");
    assert.throws(() => retryMessageDelivery(db, message.id, "sender"), { statusCode: 409 });
  } finally {
    cleanup();
  }
});

test("an atomic claim prevents nested retries and expired claims recover once", () => {
  const { db, cleanup } = fixture();
  try {
    const message = askSession(db, {
      from_session: "sender",
      to_session: "target",
      question: "hello",
    });
    retryMessageDelivery(db, message.id, "sender", () => {
      assert.throws(() => retryMessageDelivery(db, message.id, "target"), { statusCode: 409 });
      return { woke: true };
    });
    db.prepare(
      "UPDATE message_deliveries SET claim_token = 'abandoned', claim_expires_at = '2000-01-01T00:00:00.000Z' WHERE message_id = ?",
    ).run(message.id);
    const retried = retryMessageDelivery(db, message.id, "sender", () => ({ woke: true }));
    assert.equal(retried.message.delivery?.attempts, 2);
  } finally {
    cleanup();
  }
});

test("legacy messages have no invented delivery and thrown launch errors are failed", () => {
  const { db, cleanup } = fixture();
  try {
    const message = askSession(db, {
      from_session: "sender",
      to_session: "target",
      question: "hello",
    });
    assert.equal(getMessage(db, message.id)?.delivery, undefined);
    const retried = retryMessageDelivery(db, message.id, "sender", () => {
      throw new Error("secret launch details");
    });
    assert.equal(retried.message.delivery?.state, "failed");
    assert.equal(retried.message.delivery?.reason, "wake attempt failed");
  } finally {
    cleanup();
  }
});

test("initial send succeeds when a reader consumes the message before wake claiming", () => {
  const { db, cleanup } = fixture();
  try {
    db.exec(
      "CREATE TRIGGER test_reader AFTER INSERT ON messages BEGIN UPDATE messages SET status = 'seen' WHERE id = new.id; END;",
    );
    const result = askAndMaybeWake(db, {
      from_session: "sender",
      to_session: "target",
      question: "already consumed",
    });
    assert.equal(result.message.status, "seen");
    assert.equal(result.wake.woke, false);
    assert.equal(listMessages(db).length, 1);
  } finally {
    cleanup();
  }
});

test("initial send succeeds when another delivery attempt already claimed the persisted message", () => {
  const { db, cleanup } = fixture();
  try {
    db.exec(`CREATE TRIGGER test_other_retry AFTER INSERT ON messages BEGIN
      INSERT INTO message_deliveries (message_id, state, attempts, last_attempted_at, claim_token, claim_expires_at)
      VALUES (new.id, 'queued', 1, '2026-10-30T00:00:00Z', 'other-worker', '2999-01-01T00:00:00Z'); END;`);
    const result = askAndMaybeWake(db, {
      from_session: "sender",
      to_session: "target",
      question: "claimed concurrently",
    });
    assert.equal(result.message.status, "pending");
    assert.equal(result.wake.woke, false);
    assert.equal(result.message.delivery?.attempts, 1);
    assert.equal(listMessages(db).length, 1);
  } finally {
    cleanup();
  }
});
