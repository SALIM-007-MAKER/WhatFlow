USE code2mode;

CREATE TABLE IF NOT EXISTS webhook_configs (
    id          INT           NOT NULL AUTO_INCREMENT,
    url         VARCHAR(500)  NOT NULL,
    secret      VARCHAR(128)  NOT NULL,
    events      JSON          NOT NULL,
    active      TINYINT(1)    NOT NULL DEFAULT 1,
    created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_called DATETIME      NULL,
    last_status SMALLINT      NULL,
    PRIMARY KEY (id),
    INDEX idx_active (active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
