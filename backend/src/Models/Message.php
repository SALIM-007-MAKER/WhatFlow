<?php
namespace Models;
use Core\Database;

class Message {
    private Database $db;

    public function __construct() {
        $this->db = Database::getInstance();
    }

    public function byConversation(int $convId, int $page = 1, int $perPage = 50): array {
        $offset = ($page - 1) * $perPage;
        $items  = $this->db->query(
            'SELECT m.*, u.name AS sender_name
            FROM messages m
            LEFT JOIN users u ON u.id = m.sender_id
            WHERE m.conversation_id = ?
            ORDER BY m.sent_at ASC
            LIMIT ? OFFSET ?',
            [$convId, $perPage, $offset]
        )->fetchAll();

        $total = (int) $this->db->query(
            'SELECT COUNT(*) FROM messages WHERE conversation_id = ?', [$convId]
        )->fetchColumn();

        return ['items' => $items, 'total' => $total];
    }

    public function create(array $data): int {
        return $this->db->insert('messages', [
            'conversation_id'     => $data['conversation_id'],
            'sender_type'         => $data['sender_type'],
            'sender_id'           => $data['sender_id'] ?? null,
            'type'                => $data['type'] ?? 'text',
            'content'             => $data['content'] ?? null,
            'media_url'           => $data['media_url'] ?? null,
            'whatsapp_message_id' => $data['whatsapp_message_id'] ?? null,
            'status'              => $data['status'] ?? 'sent',
        ]);
    }

    public function findById(int $id): ?array {
        $row = $this->db->query(
            'SELECT m.*, u.name AS sender_name FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.id = ?',
            [$id]
        )->fetch();
        return $row ?: null;
    }

    public function updateStatus(int $id, string $status): void {
        $this->db->update('messages', ['status' => $status], 'id = ?', [$id]);
    }

    public function findByWhatsAppId(string $waId): ?array {
        $row = $this->db->query(
            'SELECT * FROM messages WHERE whatsapp_message_id = ? LIMIT 1',
            [$waId]
        )->fetch();
        return $row ?: null;
    }

    public function setWhatsAppId(int $id, string $waId): void {
        $this->db->update('messages', ['whatsapp_message_id' => $waId], 'id = ?', [$id]);
    }

    public function latest(int $convId, int $perPage): array {
        $items = $this->db->query(
            'SELECT sub.* FROM (
                SELECT m.*, u.name AS sender_name
                FROM messages m
                LEFT JOIN users u ON u.id = m.sender_id
                WHERE m.conversation_id = ?
                ORDER BY m.id DESC
                LIMIT ?
            ) sub
            ORDER BY sub.sent_at ASC',
            [$convId, $perPage]
        )->fetchAll();

        $total = (int) $this->db->query(
            'SELECT COUNT(*) FROM messages WHERE conversation_id = ?', [$convId]
        )->fetchColumn();

        return ['items' => $items, 'total' => $total];
    }

    public function before(int $convId, int $beforeId, int $perPage): array {
        return $this->db->query(
            'SELECT sub.* FROM (
                SELECT m.*, u.name AS sender_name
                FROM messages m
                LEFT JOIN users u ON u.id = m.sender_id
                WHERE m.conversation_id = ? AND m.id < ?
                ORDER BY m.id DESC
                LIMIT ?
            ) sub
            ORDER BY sub.sent_at ASC',
            [$convId, $beforeId, $perPage]
        )->fetchAll();
    }

    public function lastN(int $convId, int $n = 10): array {
        return $this->db->query(
            'SELECT * FROM messages WHERE conversation_id = ? ORDER BY sent_at DESC LIMIT ?',
            [$convId, $n]
        )->fetchAll();
    }

    public function search(string $query, int $limit = 12): array {
        return $this->db->query(
            "SELECT m.id, m.conversation_id, m.sender_type, m.type, m.content, m.sent_at,
                COALESCE(ca.custom_name, ct.display_name, ct.whatsapp_number,
                         SUBSTRING_INDEX(ct.whatsapp_jid, '@', 1)) AS contact_name,
                c.status AS conv_status
             FROM messages m
             JOIN conversations c  ON c.id  = m.conversation_id
             JOIN contacts ct      ON ct.id = c.contact_id
             LEFT JOIN contact_aliases ca ON ca.contact_id = ct.id
             WHERE m.type IN ('text','note') AND m.content LIKE ?
             ORDER BY m.sent_at DESC
             LIMIT ?",
            ['%' . $query . '%', $limit]
        )->fetchAll();
    }
}
