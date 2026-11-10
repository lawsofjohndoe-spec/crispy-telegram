CREATE TABLE bot_starts (
  telegram_user_id BIGINT PRIMARY KEY,
  first_started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  admin_notified_at TIMESTAMPTZ,
  notification_claimed_at TIMESTAMPTZ
);
