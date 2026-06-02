ALTER DATABASE code2mode CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE code2mode;

CREATE TABLE IF NOT EXISTS canned_responses (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    shortcut    VARCHAR(50)  NOT NULL COMMENT 'Mot-clé court (/bonjour)',
    title       VARCHAR(100) NOT NULL COMMENT 'Nom affiché dans le menu',
    content     TEXT         NOT NULL COMMENT 'Texte complet du template',
    created_by  INT          NULL,
    created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY  uk_shortcut (shortcut),
    CONSTRAINT  fk_cr_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Quelques templates de démo
INSERT IGNORE INTO canned_responses (shortcut, title, content, created_by) VALUES
('bonjour',     'Accueil client',          'Bonjour ! Bienvenue chez nous. Comment puis-je vous aider aujourd''hui ?', NULL),
('attente',     'Mise en attente',         'Merci pour votre patience. Je vérifie votre demande et reviens vers vous dans quelques instants.', NULL),
('remboursement','Procédure remboursement','Votre demande de remboursement a bien été enregistrée. Le traitement prend entre 5 et 10 jours ouvrés. Vous recevrez une confirmation par email.', NULL),
('livraison',   'Suivi de livraison',      'Votre commande est en cours de livraison. Vous pouvez suivre votre colis en utilisant le numéro de suivi communiqué par email.', NULL),
('escalade',    'Escalade support',        'Je comprends votre situation et transmets votre dossier à un responsable qui vous contactera sous 24h.', NULL),
('fermeture',   'Clôture conversation',    'Votre demande a été traitée. N''hésitez pas à nous recontacter si vous avez d''autres questions. Bonne journée !', NULL);
