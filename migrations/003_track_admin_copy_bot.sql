ALTER TABLE whispers
  ADD COLUMN admin_bot TEXT NOT NULL DEFAULT 'primary'
  CHECK (admin_bot IN ('primary', 'admin'));
