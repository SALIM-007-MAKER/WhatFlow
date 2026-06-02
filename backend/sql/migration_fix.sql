-- ============================================================
-- FIX MIGRATION — à exécuter une seule fois dans phpMyAdmin
-- ============================================================
USE code2mode;

-- ── 1. Compléter la migration de la table contacts ──────────

-- 1a. Rendre whatsapp_jid obligatoire
ALTER TABLE contacts
    MODIFY COLUMN whatsapp_jid VARCHAR(120) NOT NULL;

-- 1b. Ajouter l'index UNIQUE sur whatsapp_jid (clé de routage)
ALTER TABLE contacts
    ADD UNIQUE INDEX idx_whatsapp_jid (whatsapp_jid);

-- 1c. Rendre whatsapp_number nullable (les @lid n'ont pas toujours de numéro)
ALTER TABLE contacts
    MODIFY COLUMN whatsapp_number VARCHAR(30) NULL;

-- 1d. Supprimer l'ancien index UNIQUE sur whatsapp_number
--     (le nom de l'index est 'whatsapp_number' selon SHOW INDEX)
ALTER TABLE contacts
    DROP INDEX whatsapp_number;

-- 1e. Ajouter un index non-unique pour les recherches par numéro
ALTER TABLE contacts
    ADD INDEX idx_number (whatsapp_number);

-- ── 2. Corriger les JIDs @lid mal reconstruits ───────────────
-- La migration précédente a forcé '@c.us' sur tous les contacts.
-- Les vrais numéros de téléphone E.164 ont ≤ 13 chiffres sur WhatsApp.
-- Les LID interne WhatsApp ont 14-16 chiffres sans préfixe pays valide.
-- Les groupes (120363...) restent en '@c.us' (ils sont filtrés par le bridge).

UPDATE contacts
SET    whatsapp_jid = CONCAT(whatsapp_number, '@lid')
WHERE  LENGTH(whatsapp_number) >= 14
  AND  whatsapp_jid LIKE '%@c.us'
  AND  whatsapp_number NOT LIKE '120363%';

-- ── 3. Vérification finale ───────────────────────────────────
SELECT
    id,
    whatsapp_number,
    whatsapp_jid,
    display_name
FROM contacts
ORDER BY id;
