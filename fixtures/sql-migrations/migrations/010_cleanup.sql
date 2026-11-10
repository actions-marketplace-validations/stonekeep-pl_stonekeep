-- Natural ordering: 010 runs after 002.
ALTER TABLE users DROP COLUMN IF EXISTS mobile_phone;
DROP TABLE IF EXISTS audit_log;
