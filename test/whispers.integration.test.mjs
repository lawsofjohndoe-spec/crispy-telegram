import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";
import {
  activateWhisper,
  activateWhisperByToken,
  claimBotStartNotification,
  clearAdminCopyReference,
  creditEligibleStars,
  consumeWhisper,
  createWhisper,
  getEarnStatus,
  getWhisperDraft,
  getWhisperRevealFailure,
  markBotStartNotificationSent,
  recordAdminCopy,
  registerUser,
  releaseBotStartNotification,
  saveInlineMessageIdByToken,
} from "../dist/whispers.js";
import { createWhisperToken, hashWhisperToken } from "../dist/security.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("authorization, expiration, rereads, and atomic consumption", { skip: !databaseUrl }, async () => {
  const admin = new Pool({ connectionString: databaseUrl });
  const schema = `whisper_test_${randomBytes(6).toString("hex")}`;
  let pool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });
    const initialMigration = await readFile(new URL("../migrations/001_initial.sql", import.meta.url), "utf8");
    const recipientMigration = await readFile(
      new URL("../migrations/002_allow_first_time_recipients.sql", import.meta.url),
      "utf8",
    );
    const adminBotMigration = await readFile(
      new URL("../migrations/003_track_admin_copy_bot.sql", import.meta.url),
      "utf8",
    );
    const senderUsernameMigration = await readFile(
      new URL("../migrations/004_store_sender_username.sql", import.meta.url),
      "utf8",
    );
    const adminClaimMigration = await readFile(
      new URL("../migrations/005_claim_admin_copy.sql", import.meta.url),
      "utf8",
    );
    const readStatusAndEarningsMigration = await readFile(
      new URL("../migrations/006_read_status_and_earnings.sql", import.meta.url),
      "utf8",
    );
    const botStartMigration = await readFile(
      new URL("../migrations/007_track_bot_starts.sql", import.meta.url),
      "utf8",
    );
    await pool.query(initialMigration);
    await pool.query(recipientMigration);
    await pool.query(adminBotMigration);
    await pool.query(senderUsernameMigration);
    await pool.query(adminClaimMigration);
    await pool.query(readStatusAndEarningsMigration);
    await pool.query(botStartMigration);

    assert.equal(await claimBotStartNotification(pool, "606"), true);
    assert.equal(await claimBotStartNotification(pool, "606"), false);
    await releaseBotStartNotification(pool, "606");
    assert.equal(await claimBotStartNotification(pool, "606"), true);
    await markBotStartNotificationSent(pool, "606");
    assert.equal(await claimBotStartNotification(pool, "606"), false);

    const firstReceipt = await pool.query(
      `INSERT INTO processed_updates (update_id)
       VALUES ($1) ON CONFLICT (update_id) DO NOTHING RETURNING update_id`,
      ["9001"],
    );
    const duplicateReceipt = await pool.query(
      `INSERT INTO processed_updates (update_id)
       VALUES ($1) ON CONFLICT (update_id) DO NOTHING RETURNING update_id`,
      ["9001"],
    );
    assert.equal(firstReceipt.rowCount, 1);
    assert.equal(duplicateReceipt.rowCount, 0);

    const validToken = createWhisperToken();
    const valid = await createWhisper(pool, {
      token: validToken,
      senderId: "101",
      recipientId: "202",
      recipientUsername: "recipient",
      secret: "only the recipient can read this",
    });
    assert.equal(await activateWhisper(pool, valid.id, "999", "inline-forged"), null);
    await activateWhisper(pool, valid.id, "101", "inline-valid");
    assert.equal(await consumeWhisper(pool, validToken, "303", "recipient", 0), null);

    const expiredToken = createWhisperToken();
    const expired = await createWhisper(pool, {
      token: expiredToken,
      senderId: "101",
      recipientId: "202",
      recipientUsername: "recipient",
      secret: "expired secret",
    });
    await activateWhisper(pool, expired.id, "101", null);
    await pool.query("UPDATE whispers SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1", [
      expired.id,
    ]);
    assert.equal(await consumeWhisper(pool, expiredToken, "202", "recipient", 0), null);

    const firstTimeToken = createWhisperToken();
    const firstTime = await createWhisper(pool, {
      token: firstTimeToken,
      senderId: "101",
      recipientId: null,
      recipientUsername: "firsttime",
      secret: "first-time recipient secret",
    });
    await activateWhisper(pool, firstTime.id, "101", null);
    assert.equal(await consumeWhisper(pool, firstTimeToken, "404", "someoneelse", 0), null);
    const firstTimeReveal = await consumeWhisper(pool, firstTimeToken, "404", "FIRSTTIME", 0);
    assert.equal(firstTimeReveal?.secret, "first-time recipient secret");
    const claimed = await pool.query("SELECT recipient_id::text FROM whispers WHERE id = $1", [
      firstTime.id,
    ]);
    assert.equal(claimed.rows[0]?.recipient_id, "404");

    const callbackFallbackToken = createWhisperToken();
    const callbackFallback = await createWhisper(pool, {
      token: callbackFallbackToken,
      senderId: "101",
      senderUsername: "sender",
      recipientId: null,
      recipientUsername: "fallback",
      secret: "activated by recipient link",
    });
    assert.equal(
      await activateWhisperByToken(pool, callbackFallbackToken, "404", "notfallback"),
      null,
    );
    const fallbackActivation = await activateWhisperByToken(
      pool,
      callbackFallbackToken,
      "404",
      "fallback",
    );
    assert.equal(fallbackActivation?.id, callbackFallback.id);
    assert.equal(fallbackActivation?.senderId, "101");
    assert.equal(fallbackActivation?.senderUsername, "sender");
    assert.equal(
      await activateWhisperByToken(pool, callbackFallbackToken, "404", "fallback"),
      null,
    );
    const adminCopyClaim = await pool.query(
      "UPDATE whispers SET admin_copy_claimed_at = clock_timestamp() WHERE id = $1 AND admin_copy_claimed_at IS NULL RETURNING id",
      [callbackFallback.id],
    );
    assert.equal(adminCopyClaim.rowCount, 1);
    const duplicateAdminCopyClaim = await pool.query(
      "UPDATE whispers SET admin_copy_claimed_at = clock_timestamp() WHERE id = $1 AND admin_copy_claimed_at IS NULL RETURNING id",
      [callbackFallback.id],
    );
    assert.equal(duplicateAdminCopyClaim.rowCount, 0);

    const token = createWhisperToken();
    const concurrent = await createWhisper(pool, {
      token,
      senderId: "101",
      recipientId: "202",
      recipientUsername: "recipient",
      secret: "one-time secret",
    });
    await activateWhisper(pool, concurrent.id, "101", "inline-concurrent");
    await recordAdminCopy(pool, concurrent.id, "999", 42, "admin");
    assert.equal(await activateWhisper(pool, concurrent.id, "101", "inline-concurrent"), null);
    const attempts = await Promise.all([
      consumeWhisper(pool, token, "202", "recipient", 0),
      consumeWhisper(pool, token, "202", "recipient", 0),
    ]);
    assert.equal(attempts.filter(Boolean).length, 1);
    assert.equal(attempts.find(Boolean)?.secret, "one-time secret");
    assert.equal(attempts.find(Boolean)?.adminChatId, "999");
    assert.equal(attempts.find(Boolean)?.adminMessageId, 42);
    assert.equal(attempts.find(Boolean)?.adminBotKind, "admin");
    await clearAdminCopyReference(pool, concurrent.id, "999", 42, "admin");
    const clearedCopy = await pool.query(
      "SELECT admin_chat_id, admin_message_id FROM whispers WHERE id = $1",
      [concurrent.id],
    );
    assert.equal(clearedCopy.rows[0]?.admin_chat_id, null);
    assert.equal(clearedCopy.rows[0]?.admin_message_id, null);
    const consumedSecret = await pool.query("SELECT secret FROM whispers WHERE token_hash = $1", [
      hashWhisperToken(token),
    ]);
    assert.equal(consumedSecret.rows[0]?.secret, null);

    const retainedToken = createWhisperToken();
    const retained = await createWhisper(pool, {
      token: retainedToken,
      senderId: "101",
      recipientId: "202",
      recipientUsername: "recipient",
      secret: "retained secret",
    });
    await activateWhisper(pool, retained.id, "101", null);
    await saveInlineMessageIdByToken(pool, retainedToken, "inline-reread-test");
    const revealed = await consumeWhisper(pool, retainedToken, "202", "recipient", 5);
    assert.equal(revealed?.secret, "retained secret");
    assert.equal(revealed?.inlineMessageId, "inline-reread-test");
    const revisited = await consumeWhisper(pool, retainedToken, "202", "recipient", 5);
    assert.equal(revisited?.secret, "retained secret");
    assert.equal(
      await getWhisperRevealFailure(pool, retainedToken, "303", "someoneelse"),
      "claimed_by_another_account",
    );
    const stored = await pool.query("SELECT secret, read_at FROM whispers WHERE id = $1", [retained.id]);
    assert.equal(stored.rows[0]?.secret, "retained secret");
    assert.ok(stored.rows[0]?.read_at);

    await registerUser(pool, "505", "earner", true);
    const draftToken = createWhisperToken();
    const earningWhisper = await createWhisper(pool, {
      token: draftToken,
      senderId: "505",
      recipientId: null,
      recipientUsername: "recipient",
      secret: "earning whisper",
    });
    assert.equal((await getWhisperDraft(pool, draftToken, "505"))?.id, earningWhisper.id);
    assert.equal(await getWhisperDraft(pool, draftToken, "506"), null);
    await activateWhisper(pool, earningWhisper.id, "505", "inline-earner");
    for (let count = 1; count < 10; count += 1) {
      const earningToken = createWhisperToken();
      const nextWhisper = await createWhisper(pool, {
        token: earningToken,
        senderId: "505",
        recipientId: null,
        recipientUsername: "recipient",
        secret: `earning whisper ${count + 1}`,
      });
      if (count === 9) {
        assert.equal(
          (await activateWhisperByToken(pool, earningToken, "507", "recipient"))?.id,
          nextWhisper.id,
        );
      } else {
        await activateWhisper(pool, nextWhisper.id, "505", null);
      }
    }
    await pool.query(
      "UPDATE registrations SET enrolled_at = clock_timestamp() - INTERVAL '8 days' WHERE telegram_user_id = $1",
      ["505"],
    );
    const awards = await creditEligibleStars(pool);
    assert.deepEqual(awards, [{ userId: "505", starsAdded: 1, starsBalance: 1 }]);
    assert.deepEqual(await creditEligibleStars(pool), []);
    const earnStatus = await getEarnStatus(pool, "505");
    assert.ok(earnStatus.enrolledAt);
    assert.equal(earnStatus.whispersSent, 10);
    assert.equal(earnStatus.stars, 1);

    const wrongToken = createWhisperToken();
    const hiddenTokenWhisper = await createWhisper(pool, {
      token: wrongToken,
      senderId: "101",
      recipientId: "202",
      recipientUsername: "recipient",
      secret: "not stored in clear token form",
    });
    const storedHash = await pool.query("SELECT token_hash FROM whispers WHERE id = $1", [
      hiddenTokenWhisper.id,
    ]);
    assert.equal(storedHash.rows[0]?.token_hash, hashWhisperToken(wrongToken));
    assert.notEqual(storedHash.rows[0]?.token_hash, wrongToken);
  } finally {
    if (pool) {
      await pool.end();
    }
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
