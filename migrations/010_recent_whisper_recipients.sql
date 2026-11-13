CREATE TABLE IF NOT EXISTS recent_whisper_recipients (
  sender_id BIGINT NOT NULL,
  recipient_username TEXT NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (sender_id, recipient_username)
);

CREATE INDEX IF NOT EXISTS recent_whisper_recipients_sender_used_idx
  ON recent_whisper_recipients (sender_id, last_used_at DESC);
