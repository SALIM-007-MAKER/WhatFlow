USE code2mode;

CREATE TABLE IF NOT EXISTS assignment_rules (
    id              INT           NOT NULL AUTO_INCREMENT,
    name            VARCHAR(150)  NOT NULL,
    priority        SMALLINT      NOT NULL DEFAULT 0,
    active          TINYINT(1)    NOT NULL DEFAULT 1,
    conditions      JSON          NOT NULL,
    action          JSON          NOT NULL,
    match_count     INT           NOT NULL DEFAULT 0,
    last_matched_at DATETIME      NULL,
    created_by      INT           NULL,
    created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_ar_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
