USE code2mode;

CREATE TABLE IF NOT EXISTS rate_limits (
    ip           VARCHAR(45)  NOT NULL,
    endpoint     VARCHAR(100) NOT NULL,
    hits         INT          NOT NULL DEFAULT 1,
    window_start INT          NOT NULL,
    PRIMARY KEY (ip, endpoint),
    INDEX idx_window (window_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
