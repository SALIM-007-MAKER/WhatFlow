USE code2mode;

CREATE TABLE IF NOT EXISTS contact_notes (
    id         INT          NOT NULL AUTO_INCREMENT,
    contact_id INT          NOT NULL,
    agent_id   INT          NOT NULL,
    content    TEXT         NOT NULL,
    created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_contact (contact_id),
    CONSTRAINT fk_cn_contact FOREIGN KEY (contact_id) REFERENCES contacts(id)  ON DELETE CASCADE,
    CONSTRAINT fk_cn_agent   FOREIGN KEY (agent_id)   REFERENCES users(id)     ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
