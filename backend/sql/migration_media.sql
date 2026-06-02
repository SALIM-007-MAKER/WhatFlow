-- ============================================================
-- MIGRATION MEDIA — à exécuter une seule fois dans phpMyAdmin
-- ============================================================
USE code2mode;

-- Ajouter media_url à messages (si pas déjà présente)
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS media_url VARCHAR(500) NULL AFTER content;

-- Étendre le type ENUM pour inclure image, audio, video, document
ALTER TABLE messages
    MODIFY COLUMN type ENUM('text','note','image','audio','video','document') NOT NULL DEFAULT 'text';

-- Vérification
SHOW COLUMNS FROM messages;
