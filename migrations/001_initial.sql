CREATE TABLE IF NOT EXISTS registrations (
  telegram_user_id BIGINT PRIMARY KEY,
  username TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX IF NOT EXISTS registrations_username_lower_idx
  ON registrations (lower(username))
  WHERE username IS NOT NULL;

CREATE TABLE IF NOT EXISTS whispers (
  id BIGSERIAL PRIMARY KEY,
  token_hash CHAR(64) NOT NULL UNIQUE,
  sender_id BIGINT NOT NULL,
  recipient_id BIGINT NOT NULL,
  recipient_username TEXT,
  secret TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  selected_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  secret_delete_at TIMESTAMPTZ,
  admin_chat_id BIGINT,
  admin_message_id INTEGER,
  inline_message_id TEXT,
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS whispers_recipient_expiry_idx
  ON whispers (recipient_id, expires_at);
CREATE INDEX IF NOT EXISTS whispers_sender_created_idx
  ON whispers (sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS whispers_expiration_idx
  ON whispers (expires_at);

CREATE TABLE IF NOT EXISTS processed_updates (
  update_id BIGINT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS rate_limits (
  telegram_user_id BIGINT NOT NULL,
  action TEXT NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL,
  attempt_count INTEGER NOT NULL,
  PRIMARY KEY (telegram_user_id, action)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
