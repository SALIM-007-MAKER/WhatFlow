<?php
namespace Models;
use Core\Database;

class Contact {
    private Database $db;

    public function __construct() {
        $this->db = Database::getInstance();
    }

    // ── Lookups ────────────────────────────────────────────────────────────

    public function findById(int $id): ?array {
        $row = $this->db->query(
            'SELECT c.*, ca.custom_name
             FROM contacts c
             LEFT JOIN contact_aliases ca ON ca.contact_id = c.id
             WHERE c.id = ?',
            [$id]
        )->fetch();
        return $row ?: null;
    }

    public function findByJid(string $jid): ?array {
        $row = $this->db->query(
            'SELECT c.*, ca.custom_name
             FROM contacts c
             LEFT JOIN contact_aliases ca ON ca.contact_id = c.id
             WHERE c.whatsapp_jid = ?',
            [$jid]
        )->fetch();
        return $row ?: null;
    }

    public function findByNumber(string $number): ?array {
        $row = $this->db->query(
            'SELECT c.*, ca.custom_name
             FROM contacts c
             LEFT JOIN contact_aliases ca ON ca.contact_id = c.id
             WHERE c.whatsapp_number = ?',
            [$number]
        )->fetch();
        return $row ?: null;
    }

    // ── Create / update ────────────────────────────────────────────────────

    /**
     * Trouve ou crée un contact par son JID.
     * @param string      $jid    JID complet, ex. "33612345678@c.us" ou "123456789@lid"
     * @param string|null $number Vrai numéro téléphone — null pour les @lid non résolus
     * @param string      $name   Nom d'affichage initial (pushname WhatsApp)
     */
    public function firstOrCreate(string $jid, ?string $number = null, string $name = ''): array {
        $contact = $this->findByJid($jid);
        if ($contact) {
            $this->db->update('contacts', ['last_seen' => date('Y-m-d H:i:s')], 'id = ?', [$contact['id']]);
            return $contact;
        }
        $id = $this->db->insert('contacts', [
            'whatsapp_jid'    => $jid,
            'whatsapp_number' => $number,
            'display_name'    => $name ?: null,
        ]);
        return $this->findById($id);
    }

    public function update(int $id, array $data): bool {
        $allowed = array_intersect_key($data, array_flip(['display_name', 'metadata', 'whatsapp_number', 'last_seen']));
        if (empty($allowed)) return false;
        return $this->db->update('contacts', $allowed, 'id = ?', [$id]) > 0;
    }

    // ── Alias (nom personnalisé opérateur) ─────────────────────────────────

    /**
     * Enregistre ou remplace l'alias opérateur d'un contact.
     */
    public function setAlias(int $contactId, string $name, ?int $userId = null): void {
        $this->db->query(
            'INSERT INTO contact_aliases (contact_id, custom_name, user_id)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE custom_name = VALUES(custom_name),
                                     user_id     = VALUES(user_id),
                                     updated_at  = CURRENT_TIMESTAMP',
            [$contactId, $name, $userId]
        );
    }

    /**
     * Résout le nom à afficher selon la chaîne de priorité :
     * custom_name > display_name > whatsapp_number > partie locale du JID
     */
    public function getDisplayName(int $contactId): string {
        $contact = $this->findById($contactId);
        if (!$contact) return 'Inconnu';
        return $contact['custom_name']
            ?? $contact['display_name']
            ?? $contact['whatsapp_number']
            ?? explode('@', $contact['whatsapp_jid'])[0];
    }

    // ── List ────────────────────────────────────────────────────────────────

    public function all(int $page = 1, int $perPage = 20, string $search = ''): array {
        $offset = ($page - 1) * $perPage;
        $where  = '1=1';
        $params = [];
        if ($search) {
            $where    = '(c.whatsapp_number LIKE ? OR c.display_name LIKE ? OR ca.custom_name LIKE ? OR c.whatsapp_jid LIKE ?)';
            $params[] = "%$search%";
            $params[] = "%$search%";
            $params[] = "%$search%";
            $params[] = "%$search%";
        }
        $items = $this->db->query(
            "SELECT c.*, ca.custom_name
             FROM contacts c
             LEFT JOIN contact_aliases ca ON ca.contact_id = c.id
             WHERE $where
             ORDER BY c.last_seen DESC LIMIT ? OFFSET ?",
            array_merge($params, [$perPage, $offset])
        )->fetchAll();
        $total = (int) $this->db->query(
            "SELECT COUNT(*)
             FROM contacts c
             LEFT JOIN contact_aliases ca ON ca.contact_id = c.id
             WHERE $where",
            $params
        )->fetchColumn();
        return ['items' => $items, 'total' => $total];
    }
}
