ALTER TABLE users
  ADD COLUMN mobile_phone VARCHAR(32),
  ADD COLUMN date_of_birth DATE,
  ADD CONSTRAINT users_phone_chk CHECK (phone <> '');

ALTER TABLE users RENAME COLUMN full_name TO display_name;

CREATE TABLE audit_log (
  id SERIAL PRIMARY KEY,
  ip_address INET,
  action TEXT NOT NULL
);
