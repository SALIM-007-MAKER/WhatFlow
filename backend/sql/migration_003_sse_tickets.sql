CREATE TABLE IF NOT EXISTS sse_tickets (
    ticket     VARCHAR(64)  NOT NULL PRIMARY KEY,
    user_id    INT          NOT NULL,
    expires_at DATETIME     NOT NULL,
    INDEX idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
