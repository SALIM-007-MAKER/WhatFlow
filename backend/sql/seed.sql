USE code2mode;
SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;
SET FOREIGN_KEY_CHECKS = 0;

-- Reset tables
TRUNCATE TABLE sse_events;
TRUNCATE TABLE audit_logs;
TRUNCATE TABLE ai_suggestions;
TRUNCATE TABLE messages;
TRUNCATE TABLE conversations;
TRUNCATE TABLE contacts;
TRUNCATE TABLE auto_responses;
TRUNCATE TABLE users;

SET FOREIGN_KEY_CHECKS = 1;

INSERT INTO users (name, email, password_hash, role, status, max_conversations) VALUES
('Super Admin', 'superadmin@demo.com', '$2y$12$tOqp4NkN3L97mcc9k0uWUeoGdg4SDZB/JmQsogENQBMuicwGOUb/y', 'super_admin', 'available', 20),
('Administrateur', 'admin@demo.com', '$2y$12$tOqp4NkN3L97mcc9k0uWUeoGdg4SDZB/JmQsogENQBMuicwGOUb/y', 'admin', 'available', 15),
('Agent Demo', 'agent@demo.com', '$2y$12$o4pVQ7eKk.dJRSQYu8OPsO3NSgUF780zG81vRFzen5djfdxV16vz6', 'agent', 'available', 10);

-- superadmin@demo.com + admin@demo.com: password
-- agent@demo.com: agent123

INSERT INTO contacts (whatsapp_number, display_name) VALUES
('33612345678', 'Marie Dupont'),
('33698765432', 'Jean Martin'),
('33677889900', 'Sophie Bernard');

INSERT INTO conversations (contact_id, assigned_agent_id, status, priority, last_message_at, opened_at) VALUES
(1, 3, 'ongoing', 'normal', DATE_SUB(NOW(), INTERVAL 20 MINUTE), DATE_SUB(NOW(), INTERVAL 35 MINUTE)),
(2, NULL, 'new',     'high',   DATE_SUB(NOW(), INTERVAL 45 MINUTE), DATE_SUB(NOW(), INTERVAL 50 MINUTE)),
(3, 3, 'waiting', 'normal', DATE_SUB(NOW(), INTERVAL 90 MINUTE), DATE_SUB(NOW(), INTERVAL 130 MINUTE));

INSERT INTO messages (conversation_id, sender_type, sender_id, type, content, sent_at) VALUES
(1, 'contact', NULL, 'text', 'Bonjour, j''ai un problème avec ma commande', DATE_SUB(NOW(), INTERVAL 30 MINUTE)),
(1, 'agent', 3, 'text', 'Bonjour Marie, je vous aide de suite. Quel est votre numéro de commande ?', DATE_SUB(NOW(), INTERVAL 25 MINUTE)),
(1, 'contact', NULL, 'text', 'C''est la commande #12345', DATE_SUB(NOW(), INTERVAL 20 MINUTE)),
(2, 'contact', NULL, 'text', 'Bonjour, je voudrais un remboursement', DATE_SUB(NOW(), INTERVAL 45 MINUTE)),
(3, 'contact', NULL, 'text', 'Mon colis n''est toujours pas arrivé', DATE_SUB(NOW(), INTERVAL 2 HOUR)),
(3, 'agent', 3, 'text', 'Je vérifie votre suivi de livraison', DATE_SUB(NOW(), INTERVAL 90 MINUTE));

INSERT INTO auto_responses (name, trigger_type, trigger_value, response_text, is_active, priority) VALUES
('Bonjour automatique', 'equals', 'bonjour', 'Bonjour ! Merci de nous contacter. Un agent va vous répondre dans les plus brefs délais.', 1, 10),
('Horaires', 'contains', 'horaire', 'Nos agents sont disponibles du lundi au vendredi de 9h à 18h.', 1, 5),
('Remboursement', 'contains', 'remboursement', 'Pour toute demande de remboursement, un agent spécialisé va prendre en charge votre demande.', 1, 8),
('Merci', 'equals', 'merci', 'De rien ! N''hésitez pas à nous contacter si vous avez d''autres questions.', 1, 3);
