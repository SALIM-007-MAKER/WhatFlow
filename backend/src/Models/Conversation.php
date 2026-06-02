<?php
namespace Models;
use Core\Database;

class Conversation {
    private Database $db;

    public function __construct() {
        $this->db = Database::getInstance();
    }

    public function findById(int $id): ?array {
        $row = $this->db->query(
            'SELECT c.*,
                ct.whatsapp_jid, ct.whatsapp_number, ct.display_name,
                ca.custom_name,
                COALESCE(ca.custom_name, ct.display_name, ct.whatsapp_number,
                         SUBSTRING_INDEX(ct.whatsapp_jid, "@", 1)) AS effective_name,
                u.name AS agent_name, u.status AS agent_status,
                (SELECT sender_type FROM messages
                 WHERE conversation_id = c.id
                 ORDER BY sent_at DESC LIMIT 1) AS last_msg_sender
            FROM conversations c
            JOIN contacts ct ON ct.id = c.contact_id
            LEFT JOIN contact_aliases ca ON ca.contact_id = ct.id
            LEFT JOIN users u ON u.id = c.assigned_agent_id
            WHERE c.id = ?',
            [$id]
        )->fetch();
        return $row ?: null;
    }

    public function all(array $filters = [], int $page = 1, int $perPage = 20): array {
        $where  = ['1=1'];
        $params = [];

        if (isset($filters['status'])) {
            $where[]  = 'c.status = ?';
            $params[] = $filters['status'];
        }
        if (isset($filters['agent_id'])) {
            $where[]  = 'c.assigned_agent_id = ?';
            $params[] = $filters['agent_id'];
        }
        if (isset($filters['priority'])) {
            $where[]  = 'c.priority = ?';
            $params[] = $filters['priority'];
        }
        if (isset($filters['contact_id'])) {
            $where[]  = 'c.contact_id = ?';
            $params[] = $filters['contact_id'];
        }
        if (isset($filters['search'])) {
            $where[]  = '(ct.display_name LIKE ? OR ct.whatsapp_number LIKE ? OR ca.custom_name LIKE ?)';
            $params[] = '%' . $filters['search'] . '%';
            $params[] = '%' . $filters['search'] . '%';
            $params[] = '%' . $filters['search'] . '%';
        }

        $whereStr = implode(' AND ', $where);
        $offset   = ($page - 1) * $perPage;

        $items = $this->db->query(
            "SELECT c.*,
                ct.whatsapp_jid, ct.whatsapp_number, ct.display_name,
                ca.custom_name,
                COALESCE(ca.custom_name, ct.display_name, ct.whatsapp_number,
                         SUBSTRING_INDEX(ct.whatsapp_jid, '@', 1)) AS effective_name,
                u.name AS agent_name,
                (SELECT sender_type FROM messages
                 WHERE conversation_id = c.id
                 ORDER BY sent_at DESC LIMIT 1) AS last_msg_sender
            FROM conversations c
            JOIN contacts ct ON ct.id = c.contact_id
            LEFT JOIN contact_aliases ca ON ca.contact_id = ct.id
            LEFT JOIN users u ON u.id = c.assigned_agent_id
            WHERE $whereStr
            ORDER BY c.last_message_at DESC
            LIMIT ? OFFSET ?",
            array_merge($params, [$perPage, $offset])
        )->fetchAll();

        $total = (int) $this->db->query(
            "SELECT COUNT(*) FROM conversations c
             JOIN contacts ct ON ct.id = c.contact_id
             LEFT JOIN contact_aliases ca ON ca.contact_id = ct.id
             WHERE $whereStr",
            $params
        )->fetchColumn();

        return ['items' => $items, 'total' => $total];
    }

    public function create(int $contactId): int {
        return $this->db->insert('conversations', [
            'contact_id'      => $contactId,
            'status'          => 'new',
            'priority'        => 'normal',
            'last_message_at' => date('Y-m-d H:i:s'),
        ]);
    }

    public function allByContact(int $contactId, int $limit = 30): array {
        return $this->db->query(
            "SELECT c.id, c.status, c.priority, c.tags, c.opened_at, c.closed_at,
                c.last_message_at, c.ai_sentiment, c.ai_summary,
                u.name AS agent_name,
                (SELECT content FROM messages
                 WHERE conversation_id = c.id AND type = 'text'
                 ORDER BY sent_at DESC LIMIT 1) AS last_message
             FROM conversations c
             LEFT JOIN users u ON u.id = c.assigned_agent_id
             WHERE c.contact_id = ?
             ORDER BY c.last_message_at DESC
             LIMIT ?",
            [$contactId, $limit]
        )->fetchAll();
    }

    public function findOpenByContact(int $contactId): ?array {
        $row = $this->db->query(
            'SELECT * FROM conversations WHERE contact_id = ? AND status != "closed" ORDER BY opened_at DESC LIMIT 1',
            [$contactId]
        )->fetch();
        return $row ?: null;
    }

    public function updateStatus(int $id, string $status): bool {
        $data = ['status' => $status];
        if ($status === 'closed') $data['closed_at'] = date('Y-m-d H:i:s');
        return $this->db->update('conversations', $data, 'id = ?', [$id]) > 0;
    }

    public function assign(int $id, int $agentId): bool {
        return $this->db->update('conversations', [
            'assigned_agent_id' => $agentId,
            'status'            => 'assigned',
        ], 'id = ?', [$id]) > 0;
    }

    public function updateLastMessage(int $id): void {
        $this->db->update('conversations', ['last_message_at' => date('Y-m-d H:i:s')], 'id = ?', [$id]);
    }

    public function updatePriority(int $id, string $priority): bool {
        return $this->db->update('conversations', ['priority' => $priority], 'id = ?', [$id]) > 0;
    }

    public function updateTags(int $id, array $tags): bool {
        return $this->db->update('conversations', ['tags' => json_encode(array_values($tags))], 'id = ?', [$id]) > 0;
    }

    public function activeByAgent(int $agentId): array {
        return $this->db->query(
            "SELECT id FROM conversations
             WHERE assigned_agent_id = ? AND status NOT IN ('closed','new')
             ORDER BY last_message_at DESC",
            [$agentId]
        )->fetchAll();
    }

    public function resetToQueue(int $id): void {
        $this->db->update('conversations', [
            'assigned_agent_id' => null,
            'status'            => 'new',
        ], 'id = ?', [$id]);
    }

    public function bulkUpdateStatus(array $ids, string $status): int {
        if (!$ids) return 0;
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        return $this->db->query(
            "UPDATE conversations SET status = ?, updated_at = NOW() WHERE id IN ($placeholders)",
            array_merge([$status], $ids)
        )->rowCount();
    }

    public function bulkAssign(array $ids, int $agentId): int {
        if (!$ids) return 0;
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        return $this->db->query(
            "UPDATE conversations SET assigned_agent_id = ?, status = 'assigned', updated_at = NOW() WHERE id IN ($placeholders)",
            array_merge([$agentId], $ids)
        )->rowCount();
    }

    public function bulkUpdatePriority(array $ids, string $priority): int {
        if (!$ids) return 0;
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        return $this->db->query(
            "UPDATE conversations SET priority = ?, updated_at = NOW() WHERE id IN ($placeholders)",
            array_merge([$priority], $ids)
        )->rowCount();
    }

    public function updateAnalysis(int $id, array $analysis): void {
        $this->db->update('conversations', [
            'ai_sentiment'   => $analysis['sentiment']    ?? null,
            'ai_summary'     => $analysis['summary']      ?? null,
            'ai_intent'      => $analysis['intent']       ?? null,
            'ai_quality'     => isset($analysis['quality_score']) ? (float) $analysis['quality_score'] : null,
            'ai_analyzed_at' => date('Y-m-d H:i:s'),
        ], 'id = ?', [$id]);
    }
}
