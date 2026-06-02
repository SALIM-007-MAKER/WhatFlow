-- Migration : séparation JID / numéro de téléphone
-- Exécuter UNE SEULE FOIS sur une base existante.
-- Pour une installation neuve, utiliser schema.sql directement.

USE code2mode;

-- 1. Ajouter la colonne JID (nullable d'abord pour permettre la migration)
ALTER TABLE contacts
    ADD COLUMN whatsapp_jid VARCHAR(50) NULL AFTER id;

-- 2. Reconstruire le JID depuis les numéros existants (@c.us pour les contacts classiques)
UPDATE contacts
SET whatsapp_jid = CONCAT(whatsapp_number, '@c.us')
WHERE whatsapp_jid IS NULL;

-- 3. Rendre JID obligatoire, ajouter l'index unique, rendre le numéro nullable
ALTER TABLE contacts
    MODIFY COLUMN whatsapp_jid VARCHAR(50) NOT NULL,
    ADD  UNIQUE INDEX idx_whatsapp_jid (whatsapp_jid),
    MODIFY COLUMN whatsapp_number VARCHAR(30) NULL,
    ADD  INDEX idx_number (whatsapp_number);

-- 4. Ajouter le statut 'unconfirmed' (ACK WhatsApp non reçu dans les délais)
ALTER TABLE messages
    MODIFY COLUMN status ENUM('sent','delivered','read','failed','unconfirmed') NOT NULL DEFAULT 'sent';

-- 5. Table des noms personnalisés par contact (alias opérateur)
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
