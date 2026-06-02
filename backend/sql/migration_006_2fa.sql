USE code2mode;

ALTER TABLE users
    ADD COLUMN totp_secret   VARCHAR(64)   NULL        AFTER password_hash,
    ADD COLUMN totp_enabled  TINYINT(1)    NOT NULL DEFAULT 0 AFTER totp_secret,
    ADD COLUMN totp_enabled_at DATETIME    NULL        AFTER totp_enabled;
