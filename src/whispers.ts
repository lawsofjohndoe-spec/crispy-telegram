import type { Pool } from "pg";
import { hashWhisperToken } from "./security.js";

export type AdminBotKind = "primary" | "admin";

export interface NewWhisper {
  token: string;
  senderId: string;
  senderUsername?: string | null;
  recipientId: string | null;
  recipientUsername: string;
  secret: string;
}

export interface StoredWhisper {
  id: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface SelectedWhisper {
  id: string;
  senderId: string;
  senderUsername: string | null;
  recipientId: string | null;
  recipientUsername: string;
  secret: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface RevealedWhisper {
  id: string;
  secret: string;
  createdAt: Date;
  expiresAt: Date;
  recipientUsername: string;
  inlineMessageId: string | null;
  adminChatId: string | null;
  adminMessageId: number | null;
  adminBotKind: AdminBotKind;
}

export interface EarnStatus {
  enrolledAt: Date | null;
  whispersSent: number;
  stars: number;
}

export interface CreditedStars {
  userId: string;
  starsAdded: number;
  starsBalance: number;
}

export interface StartStarAward {
  awarded: boolean;
  starsBalance: number;
}

export async function initializeUserOnStart(
  pool: Pool,
  telegramUserId: string,
  username: string | null,
): Promise<StartStarAward> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (username) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext(lower($1)))", [username]);
      await client.query(
        `UPDATE registrations
         SET username = NULL, updated_at = clock_timestamp()
         WHERE lower(username) = lower($1) AND telegram_user_id <> $2`,
        [username, telegramUserId],
      );
    }
    await client.query(
      `INSERT INTO bot_starts (telegram_user_id)
       VALUES ($1)
       ON CONFLICT (telegram_user_id) DO NOTHING`,
      [telegramUserId],
    );
    const award = await client.query(
      `UPDATE bot_starts
       SET welcome_star_awarded_at = clock_timestamp()
       WHERE telegram_user_id = $1 AND welcome_star_awarded_at IS NULL
       RETURNING telegram_user_id`,
      [telegramUserId],
    );
    const registration = await client.query<{ stars: string }>(
      `INSERT INTO registrations (telegram_user_id, username, updated_at, enrolled_at, stars)
       VALUES ($1, $2, clock_timestamp(), clock_timestamp(), CASE WHEN $3 THEN 1 ELSE 0 END)
       ON CONFLICT (telegram_user_id) DO UPDATE
       SET username = EXCLUDED.username,
           updated_at = clock_timestamp(),
           enrolled_at = COALESCE(registrations.enrolled_at, clock_timestamp()),
           stars = registrations.stars + CASE WHEN $3 THEN 1 ELSE 0 END
       RETURNING stars::text`,
      [telegramUserId, username, award.rowCount === 1],
    );
    await client.query("COMMIT");
    return {
      awarded: award.rowCount === 1,
      starsBalance: Number(registration.rows[0]!.stars),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function claimBotStartNotification(
  pool: Pool,
  telegramUserId: string,
): Promise<boolean> {
  await pool.query(
    `INSERT INTO bot_starts (telegram_user_id)
     VALUES ($1)
     ON CONFLICT (telegram_user_id) DO NOTHING`,
    [telegramUserId],
  );
  const result = await pool.query(
    `UPDATE bot_starts
     SET notification_claimed_at = clock_timestamp()
     WHERE telegram_user_id = $1
       AND admin_notified_at IS NULL
       AND (
         notification_claimed_at IS NULL
         OR notification_claimed_at < clock_timestamp() - INTERVAL '2 minutes'
       )
     RETURNING telegram_user_id`,
    [telegramUserId],
  );
  return result.rowCount === 1;
}

export async function markBotStartNotificationSent(
  pool: Pool,
  telegramUserId: string,
): Promise<void> {
  const result = await pool.query(
    `UPDATE bot_starts
     SET admin_notified_at = clock_timestamp(), notification_claimed_at = NULL
     WHERE telegram_user_id = $1
       AND admin_notified_at IS NULL
       AND notification_claimed_at IS NOT NULL`,
    [telegramUserId],
  );
  if (result.rowCount !== 1) {
    throw new Error("Could not mark bot-start notification as sent");
  }
}

export async function releaseBotStartNotification(
  pool: Pool,
  telegramUserId: string,
): Promise<void> {
  await pool.query(
    `UPDATE bot_starts
     SET notification_claimed_at = NULL
     WHERE telegram_user_id = $1 AND admin_notified_at IS NULL`,
    [telegramUserId],
  );
}

export async function registerUser(
  pool: Pool,
  telegramUserId: string,
  username: string | null,
  enroll = false,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (username) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext(lower($1)))", [username]);
      await client.query(
        `UPDATE registrations
         SET username = NULL, updated_at = clock_timestamp()
         WHERE lower(username) = lower($1) AND telegram_user_id <> $2`,
        [username, telegramUserId],
      );
    }
    await client.query(
      `INSERT INTO registrations (telegram_user_id, username, updated_at, enrolled_at)
       VALUES ($1, $2, clock_timestamp(), CASE WHEN $3 THEN clock_timestamp() ELSE NULL END)
       ON CONFLICT (telegram_user_id) DO UPDATE
       SET username = EXCLUDED.username,
           updated_at = clock_timestamp(),
           enrolled_at = CASE
             WHEN $3 THEN COALESCE(registrations.enrolled_at, clock_timestamp())
             ELSE registrations.enrolled_at
           END`,
      [telegramUserId, username, enroll],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function findRegisteredRecipient(
  pool: Pool,
  username: string,
): Promise<{ telegramUserId: string; username: string } | null> {
  const result = await pool.query<{ telegram_user_id: string; username: string }>(
    `SELECT telegram_user_id::text, username
     FROM registrations
     WHERE lower(username) = lower($1)
     LIMIT 1`,
    [username],
  );
  const row = result.rows[0];
  return row ? { telegramUserId: row.telegram_user_id, username: row.username } : null;
}

export async function createWhisper(pool: Pool, whisper: NewWhisper): Promise<StoredWhisper> {
  const result = await pool.query<{
    id: string;
    created_at: Date;
    expires_at: Date;
  }>(
    `INSERT INTO whispers
       (token_hash, sender_id, sender_username, recipient_id, recipient_username, secret, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp() + INTERVAL '15 minutes')
     RETURNING id::text, created_at, expires_at`,
    [
      hashWhisperToken(whisper.token),
      whisper.senderId,
      whisper.senderUsername ?? null,
      whisper.recipientId,
      whisper.recipientUsername,
      whisper.secret,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Whisper insert returned no row");
  }
  return {
    id: row.id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export async function getWhisperDraft(
  pool: Pool,
  token: string,
  senderId: string,
): Promise<{ id: string; recipientUsername: string } | null> {
  const result = await pool.query<{ id: string; recipient_username: string }>(
    `SELECT id::text, recipient_username
     FROM whispers
     WHERE token_hash = $1 AND sender_id = $2
       AND selected_at IS NULL AND expires_at > clock_timestamp()`,
    [hashWhisperToken(token), senderId],
  );
  const row = result.rows[0];
  return row ? { id: row.id, recipientUsername: row.recipient_username } : null;
}

export async function saveInlineMessageIdByToken(
  pool: Pool,
  token: string,
  inlineMessageId: string,
): Promise<void> {
  await pool.query(
    `UPDATE whispers
     SET inline_message_id = $2
     WHERE token_hash = $1 AND expires_at > clock_timestamp()`,
    [hashWhisperToken(token), inlineMessageId],
  );
}

export async function activateWhisper(
  pool: Pool,
  id: string,
  senderId: string,
  inlineMessageId: string | null,
): Promise<SelectedWhisper | null> {
  const result = await pool.query<{
    id: string;
    sender_id: string;
    sender_username: string | null;
    recipient_id: string | null;
    recipient_username: string;
    secret: string;
    created_at: Date;
    expires_at: Date;
  }>(
    `WITH activated AS (
       UPDATE whispers
       SET created_at = clock_timestamp(),
           expires_at = clock_timestamp() + INTERVAL '24 hours',
           selected_at = clock_timestamp(),
           inline_message_id = $3
       WHERE id = $1 AND sender_id = $2
         AND selected_at IS NULL
         AND expires_at > clock_timestamp()
       RETURNING id, sender_id, sender_username, recipient_id, recipient_username,
                 secret, created_at, expires_at
     ),
     counted AS (
       UPDATE registrations AS r
       SET whispers_sent = r.whispers_sent + 1
       FROM activated AS a
       WHERE r.telegram_user_id = a.sender_id AND r.enrolled_at IS NOT NULL
       RETURNING r.telegram_user_id
     )
     SELECT id::text, sender_id::text, sender_username, recipient_id::text, recipient_username,
            secret, created_at, expires_at
     FROM activated`,
    [id, senderId, inlineMessageId],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        senderId: row.sender_id,
        senderUsername: row.sender_username,
        recipientId: row.recipient_id,
        recipientUsername: row.recipient_username,
        secret: row.secret,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      }
    : null;
}

export async function activateWhisperByToken(
  pool: Pool,
  token: string,
  recipientId: string,
  recipientUsername: string | null,
): Promise<SelectedWhisper | null> {
  const result = await pool.query<{
    id: string;
    sender_id: string;
    sender_username: string | null;
    recipient_id: string | null;
    recipient_username: string;
    secret: string;
    created_at: Date;
    expires_at: Date;
  }>(
    `WITH activated AS (
       UPDATE whispers
       SET created_at = clock_timestamp(),
           expires_at = clock_timestamp() + INTERVAL '24 hours',
           selected_at = clock_timestamp()
       WHERE token_hash = $1
         AND (
           recipient_id = $2
           OR (
             recipient_id IS NULL
             AND $3::text IS NOT NULL
             AND lower(recipient_username) = lower($3)
           )
         )
         AND selected_at IS NULL
         AND expires_at > clock_timestamp()
       RETURNING id, sender_id, sender_username, recipient_id, recipient_username,
                 secret, created_at, expires_at
     ),
     counted AS (
       UPDATE registrations AS r
       SET whispers_sent = r.whispers_sent + 1
       FROM activated AS a
       WHERE r.telegram_user_id = a.sender_id AND r.enrolled_at IS NOT NULL
       RETURNING r.telegram_user_id
     )
     SELECT id::text, sender_id::text, sender_username, recipient_id::text, recipient_username,
            secret, created_at, expires_at
     FROM activated`,
    [hashWhisperToken(token), recipientId, recipientUsername],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        senderId: row.sender_id,
        senderUsername: row.sender_username,
        recipientId: row.recipient_id,
        recipientUsername: row.recipient_username,
        secret: row.secret,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      }
    : null;
}

export async function recordAdminCopy(
  pool: Pool,
  id: string,
  chatId: string,
  messageId: number,
  botKind: AdminBotKind,
): Promise<void> {
  const result = await pool.query(
    `UPDATE whispers
     SET admin_chat_id = $2, admin_message_id = $3, admin_bot = $4,
         admin_copy_claimed_at = NULL
     WHERE id = $1 AND selected_at IS NOT NULL AND expires_at > clock_timestamp()`,
    [id, chatId, messageId, botKind],
  );
  if (result.rowCount !== 1) {
    throw new Error("Could not persist admin-copy message reference");
  }
}

export async function clearAdminCopyReference(
  pool: Pool,
  id: string,
  chatId: string,
  messageId: number,
  botKind: AdminBotKind,
): Promise<void> {
  await pool.query(
    `UPDATE whispers
     SET admin_chat_id = NULL, admin_message_id = NULL
     WHERE id = $1 AND admin_chat_id = $2 AND admin_message_id = $3 AND admin_bot = $4`,
    [id, chatId, messageId, botKind],
  );
}

export async function claimAdminCopy(
  pool: Pool,
  whisperId: string,
): Promise<SelectedWhisper | null> {
  const result = await pool.query<{
    id: string;
    sender_id: string;
    sender_username: string | null;
    recipient_id: string | null;
    recipient_username: string;
    secret: string;
    created_at: Date;
    expires_at: Date;
  }>(
    `UPDATE whispers
     SET admin_copy_claimed_at = clock_timestamp()
     WHERE id = $1
       AND selected_at IS NOT NULL
       AND read_at IS NULL
       AND secret IS NOT NULL
       AND admin_chat_id IS NULL
       AND (
         admin_copy_claimed_at IS NULL
         OR admin_copy_claimed_at < clock_timestamp() - INTERVAL '2 minutes'
       )
     RETURNING id::text, sender_id::text, sender_username, recipient_id::text,
               recipient_username, secret, created_at, expires_at`,
    [whisperId],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        senderId: row.sender_id,
        senderUsername: row.sender_username,
        recipientId: row.recipient_id,
        recipientUsername: row.recipient_username,
        secret: row.secret,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      }
    : null;
}

export async function claimAdminCopyByToken(
  pool: Pool,
  token: string,
): Promise<SelectedWhisper | null> {
  const result = await pool.query<{
    id: string;
    sender_id: string;
    sender_username: string | null;
    recipient_id: string | null;
    recipient_username: string;
    secret: string;
    created_at: Date;
    expires_at: Date;
  }>(
    `UPDATE whispers
     SET admin_copy_claimed_at = clock_timestamp()
     WHERE token_hash = $1
       AND selected_at IS NOT NULL
       AND read_at IS NULL
       AND secret IS NOT NULL
       AND admin_chat_id IS NULL
       AND (
         admin_copy_claimed_at IS NULL
         OR admin_copy_claimed_at < clock_timestamp() - INTERVAL '2 minutes'
       )
     RETURNING id::text, sender_id::text, sender_username, recipient_id::text,
               recipient_username, secret, created_at, expires_at`,
    [hashWhisperToken(token)],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        senderId: row.sender_id,
        senderUsername: row.sender_username,
        recipientId: row.recipient_id,
        recipientUsername: row.recipient_username,
        secret: row.secret,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      }
    : null;
}

export async function releaseAdminCopyClaim(pool: Pool, whisperId: string): Promise<void> {
  await pool.query(
    `UPDATE whispers
     SET admin_copy_claimed_at = NULL
     WHERE id = $1 AND admin_chat_id IS NULL`,
    [whisperId],
  );
}

export async function removeWhisper(pool: Pool, id: string): Promise<void> {
  await pool.query("DELETE FROM whispers WHERE id = $1", [id]);
}

export async function consumeWhisper(
  pool: Pool,
  token: string,
  recipientId: string,
  recipientUsername: string | null,
  retentionMinutes: number,
): Promise<RevealedWhisper | null> {
  const result = await pool.query<{
    id: string;
    secret: string;
    created_at: Date;
    expires_at: Date;
    recipient_username: string;
    inline_message_id: string | null;
    admin_chat_id: string | null;
    admin_message_id: number | null;
    admin_bot: AdminBotKind;
  }>(
    `WITH candidate AS (
       SELECT id, secret
       FROM whispers
       WHERE token_hash = $1
         AND (
           recipient_id = $2
           OR (
             recipient_id IS NULL
             AND $4::text IS NOT NULL
             AND lower(recipient_username) = lower($4)
           )
         )
         AND expires_at > clock_timestamp()
         AND selected_at IS NOT NULL
         AND secret IS NOT NULL
         AND (secret_delete_at IS NULL OR secret_delete_at > clock_timestamp())
       FOR UPDATE
     )
     UPDATE whispers AS w
     SET recipient_id = COALESCE(w.recipient_id, $2),
         read_at = COALESCE(w.read_at, clock_timestamp()),
         secret_delete_at = CASE
           WHEN w.read_at IS NOT NULL THEN w.secret_delete_at
           WHEN $3::integer > 0
           THEN LEAST(clock_timestamp() + ($3::text || ' minutes')::interval, w.expires_at)
           ELSE NULL
         END,
         secret = CASE
           WHEN w.read_at IS NOT NULL OR $3::integer > 0 THEN w.secret
           ELSE NULL
         END
     FROM candidate AS c
     WHERE w.id = c.id
       AND w.expires_at > clock_timestamp()
     RETURNING w.id::text, c.secret, w.created_at, w.expires_at,
               w.recipient_username, w.inline_message_id,
               w.admin_chat_id::text, w.admin_message_id, w.admin_bot`,
    [hashWhisperToken(token), recipientId, retentionMinutes, recipientUsername],
  );
  const row = result.rows[0];
  return row
    ? {
      id: row.id,
      secret: row.secret,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      recipientUsername: row.recipient_username,
      inlineMessageId: row.inline_message_id,
      adminChatId: row.admin_chat_id,
      adminMessageId: row.admin_message_id,
      adminBotKind: row.admin_bot,
    }
    : null;
}

export async function getWhisperRevealFailure(
  pool: Pool,
  token: string,
  recipientId: string,
  recipientUsername: string | null,
): Promise<"username_mismatch" | "claimed_by_another_account" | null> {
  const result = await pool.query<{
    recipient_id: string | null;
    recipient_username: string;
  }>(
    `SELECT recipient_id::text, recipient_username
     FROM whispers
     WHERE token_hash = $1
       AND expires_at > clock_timestamp()`,
    [hashWhisperToken(token)],
  );
  const whisper = result.rows[0];
  if (!whisper) {
    return null;
  }
  if (whisper.recipient_id !== null && whisper.recipient_id !== recipientId) {
    return "claimed_by_another_account";
  }
  if (
    whisper.recipient_id === null &&
    (recipientUsername === null ||
      whisper.recipient_username.toLowerCase() !== recipientUsername.toLowerCase())
  ) {
    return "username_mismatch";
  }
  return null;
}

export async function creditEligibleStars(
  pool: Pool,
  userId?: string,
): Promise<CreditedStars[]> {
  const result = await pool.query<{
    user_id: string;
    stars_added: string;
    stars_balance: string;
  }>(
    `WITH due AS (
       SELECT telegram_user_id, stars, whisper_stars,
              (whispers_sent / 10) AS target_stars
       FROM registrations
       WHERE enrolled_at <= clock_timestamp() - INTERVAL '7 days'
         AND whisper_stars < (whispers_sent / 10)
         AND ($1::text IS NULL OR telegram_user_id = $1)
       FOR UPDATE SKIP LOCKED
     )
     UPDATE registrations AS r
     SET stars = r.stars + (due.target_stars - due.whisper_stars),
         whisper_stars = due.target_stars
     FROM due
     WHERE r.telegram_user_id = due.telegram_user_id
       AND r.whisper_stars < due.target_stars
     RETURNING r.telegram_user_id::text AS user_id,
               (r.whisper_stars - due.whisper_stars)::text AS stars_added,
               r.stars::text AS stars_balance`,
    [userId ?? null],
  );
  return result.rows.map((row) => ({
    userId: row.user_id,
    starsAdded: Number(row.stars_added),
    starsBalance: Number(row.stars_balance),
  }));
}

export async function getEarnStatus(pool: Pool, userId: string): Promise<EarnStatus> {
  const result = await pool.query<{
    enrolled_at: Date | null;
    whispers_sent: string;
    stars: string;
  }>(
    `SELECT enrolled_at, whispers_sent::text, stars::text
     FROM registrations
     WHERE telegram_user_id = $1`,
    [userId],
  );
  const row = result.rows[0];
  return row
    ? {
        enrolledAt: row.enrolled_at,
        whispersSent: Number(row.whispers_sent),
        stars: Number(row.stars),
      }
    : { enrolledAt: null, whispersSent: 0, stars: 0 };
}

export async function forgetUser(pool: Pool, telegramUserId: string): Promise<
  Array<{ chatId: string; messageId: number; botKind: AdminBotKind }>
> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const adminCopies = await client.query<{
      chat_id: string;
      message_id: number;
      admin_bot: AdminBotKind;
    }>(
      `SELECT admin_chat_id::text AS chat_id, admin_message_id AS message_id, admin_bot
       FROM whispers
       WHERE recipient_id = $1 AND read_at IS NULL
         AND admin_chat_id IS NOT NULL AND admin_message_id IS NOT NULL`,
      [telegramUserId],
    );
    await client.query("DELETE FROM registrations WHERE telegram_user_id = $1", [telegramUserId]);
    await client.query(
      "DELETE FROM whispers WHERE recipient_id = $1 AND read_at IS NULL",
      [telegramUserId],
    );
    await client.query("COMMIT");
    return adminCopies.rows.map((row) => ({
      chatId: row.chat_id,
      messageId: row.message_id,
      botKind: row.admin_bot,
    }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function allowRateLimitedAction(
  pool: Pool,
  userId: string,
  action: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const result = await pool.query<{ attempt_count: number; allowed: boolean }>(
    `INSERT INTO rate_limits (telegram_user_id, action, window_started_at, attempt_count)
     VALUES ($1, $2, clock_timestamp(), 1)
     ON CONFLICT (telegram_user_id, action) DO UPDATE SET
       window_started_at = CASE
         WHEN rate_limits.window_started_at <=
           clock_timestamp() - ($4::text || ' seconds')::interval
         THEN clock_timestamp()
         ELSE rate_limits.window_started_at
       END,
       attempt_count = CASE
         WHEN rate_limits.window_started_at <=
           clock_timestamp() - ($4::text || ' seconds')::interval
         THEN 1
         ELSE rate_limits.attempt_count + 1
       END
     RETURNING attempt_count, attempt_count <= $3 AS allowed`,
    [userId, action, limit, windowSeconds],
  );
  return result.rows[0]?.allowed ?? false;
}

export async function getAdminStatus(
  pool: Pool,
): Promise<{ registrations: number; unread: number; expiredPendingCleanup: number }> {
  const result = await pool.query<{
    registrations: string;
    unread: string;
    expired_pending_cleanup: string;
  }>(
    `SELECT
       (SELECT count(*) FROM registrations) AS registrations,
       (SELECT count(*) FROM whispers WHERE selected_at IS NOT NULL AND read_at IS NULL AND expires_at > clock_timestamp()) AS unread,
       (SELECT count(*) FROM whispers WHERE expires_at <= clock_timestamp()) AS expired_pending_cleanup`,
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Admin status query returned no row");
  }
  return {
    registrations: Number(row.registrations),
    unread: Number(row.unread),
    expiredPendingCleanup: Number(row.expired_pending_cleanup),
  };
}

export async function cleanupExpired(
  pool: Pool,
): Promise<Array<{ id: string; chatId: string; messageId: number; botKind: AdminBotKind }>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const expired = await client.query<{
      id: string;
      chat_id: string | null;
      message_id: number | null;
      admin_bot: AdminBotKind;
    }>(
      `SELECT id::text, admin_chat_id::text AS chat_id, admin_message_id AS message_id, admin_bot
       FROM whispers
       WHERE expires_at <= clock_timestamp()
       ORDER BY expires_at
       LIMIT 500
       FOR UPDATE SKIP LOCKED`,
    );
    await client.query(
      `UPDATE whispers
       SET secret = NULL, secret_delete_at = NULL
       WHERE secret_delete_at <= clock_timestamp() AND expires_at > clock_timestamp()`,
    );
    await client.query(
      `DELETE FROM whispers
       WHERE id = ANY($1::bigint[])`,
      [expired.rows.map((row) => row.id)],
    );
    await client.query("DELETE FROM processed_updates WHERE received_at < clock_timestamp() - INTERVAL '7 days'");
    await client.query("COMMIT");
    return expired.rows.flatMap((row) =>
      row.chat_id !== null && row.message_id !== null
        ? [{
            id: row.id,
            chatId: row.chat_id,
            messageId: row.message_id,
            botKind: row.admin_bot,
          }]
        : [],
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
