ALTER TABLE registrations
  ADD COLUMN whisper_stars BIGINT NOT NULL DEFAULT 0;

UPDATE registrations
SET whisper_stars = LEAST(stars, whispers_sent / 10);
