CREATE DATABASE IF NOT EXISTS code2mode
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE code2mode;

CREATE TABLE IF NOT EXISTS users (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  name                VARCHAR(100) NOT NULL,
  email               VARCHAR(150) UNIQUE NOT NULL,
  password_hash       VARCHAR(255) NOT NULL,
  role                ENUM('super_admin','admin','agent') NOT NULL DEFAULT 'agent',
  status              ENUM('available','busy','inactive','offline') NOT NULL DEFAULT 'offline',
  max_conversations   INT NOT NULL DEFAULT 10,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contacts (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  whatsapp_jid        VARCHAR(50)  UNIQUE NOT NULL,  -- identifiant JID complet (@c.us ou @lid)
  whatsapp_number     VARCHAR(30)  NULL,             -- vrai numéro téléphone, nullable (@lid sans résolution)
  display_name        VARCHAR(150) NULL,
  metadata            JSON NULL,
  first_seen          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen           TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_number    (whatsapp_number)
);

CREATE TABLE IF NOT EXISTS conversations (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  contact_id          INT NOT NULL,
  assigned_agent_id   INT NULL,
  status              ENUM('new','assigned','ongoing','waiting','closed') NOT NULL DEFAULT 'new',
  priority            ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
  tags                JSON NULL,
  opened_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  closed_at           TIMESTAMP NULL,
  last_message_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ai_sentiment        VARCHAR(20)    NULL,
  ai_summary          TEXT           NULL,
  ai_intent           VARCHAR(255)   NULL,
  ai_quality          DECIMAL(4,2)   NULL,
  ai_analyzed_at      DATETIME       NULL,
  FOREIGN KEY (contact_id)          REFERENCES contacts(id),
  FOREIGN KEY (assigned_agent_id)   REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_status          (status),
  INDEX idx_agent           (assigned_agent_id),
  INDEX idx_last_msg        (last_message_at),
  INDEX idx_contact_status  (contact_id, status)
);

CREATE TABLE IF NOT EXISTS messages (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  conversation_id     INT NOT NULL,
  sender_type         ENUM('contact','agent','bot','system') NOT NULL,
  sender_id           INT NULL,
  type                ENUM('text','image','audio','video','document','note') NOT NULL DEFAULT 'text',
  content             TEXT NULL,
  media_url           VARCHAR(500) NULL,
  whatsapp_message_id VARCHAR(100) NULL,
  status              ENUM('sent','delivered','read','failed','unconfirmed') NOT NULL DEFAULT 'sent',
  sent_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  INDEX idx_conv      (conversation_id),
  INDEX idx_sent_at   (sent_at),
  INDEX idx_wa_id     (whatsapp_message_id)
);

CREATE TABLE IF NOT EXISTS ai_suggestions (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  conversation_id     INT NOT NULL,
  suggestion_text     TEXT NOT NULL,
  confidence_score    DECIMAL(3,2) NULL,
  was_used            TINYINT(1) DEFAULT 0,
  was_modified        TINYINT(1) DEFAULT 0,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auto_responses (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  name                VARCHAR(100) NOT NULL,
  trigger_type        ENUM('contains','equals','starts_with') NOT NULL,
  trigger_value       VARCHAR(255) NOT NULL,
  response_text       TEXT NOT NULL,
  is_active           TINYINT(1) DEFAULT 1,
  priority            INT DEFAULT 0,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  user_id             INT NULL,
  action              VARCHAR(100) NOT NULL,
  entity_type         VARCHAR(50) NULL,
  entity_id           INT NULL,
  details             JSON NULL,
  ip_address          VARCHAR(45) NULL,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user      (user_id),
  INDEX idx_action    (action),
  INDEX idx_date      (created_at)
);

CREATE TABLE IF NOT EXISTS contact_aliases (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  contact_id      INT NOT NULL,
  custom_name     VARCHAR(150) NOT NULL,
  created_by      INT NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_contact (contact_id),
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)    ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sse_events (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  target_user_id      INT NULL,
  event_type          VARCHAR(100) NOT NULL,
  payload             JSON NOT NULL,
  is_consumed         TINYINT(1) DEFAULT 0,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_consumed  (is_consumed),
  INDEX idx_user      (target_user_id),
  INDEX idx_created   (created_at)
);

CREATE TABLE IF NOT EXISTS sse_tickets (
  ticket              VARCHAR(64)  NOT NULL PRIMARY KEY,
  user_id             INT          NOT NULL,
  expires_at          DATETIME     NOT NULL,
  INDEX idx_expires   (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
