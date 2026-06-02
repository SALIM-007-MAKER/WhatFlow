<?php
namespace Models;
use Core\Database;

class AuditLog {
    private Database $db;

    public function __construct() {
        $this->db = Database::getInstance();
    }

    public function log(string $action, ?int $userId = null, string $entityType = '', ?int $entityId = null, array $details = []): void {
        $this->db->insert('audit_logs', [
            'user_id'     => $userId,
            'action'      => $action,
            'entity_type' => $entityType ?: null,
            'entity_id'   => $entityId,
            'details'     => $details ? json_encode($details) : null,
            'ip_address'  => $_SERVER['REMOTE_ADDR'] ?? null,
        ]);
    }

    public function all(int $page = 1, int $perPage = 50, array $filters = []): array {
        $where  = ['1=1'];
        $params = [];

        if (isset($filters['user_id'])) {
            $where[]  = 'al.user_id = ?';
            $params[] = $filters['user_id'];
        }
        if (isset($filters['action'])) {
            $where[]  = 'al.action = ?';
            $params[] = $filters['action'];
        }
        if (isset($filters['date_from'])) {
            $where[]  = 'al.created_at >= ?';
            $params[] = $filters['date_from'];
        }

        $whereStr = implode(' AND ', $where);
        $offset   = ($page - 1) * $perPage;

        $items = $this->db->query(
            "SELECT al.*, u.name AS user_name
            FROM audit_logs al
            LEFT JOIN users u ON u.id = al.user_id
            WHERE $whereStr
            ORDER BY al.created_at DESC
            LIMIT ? OFFSET ?",
            array_merge($params, [$perPage, $offset])
        )->fetchAll();

        $total = (int) $this->db->query("SELECT COUNT(*) FROM audit_logs al WHERE $whereStr", $params)->fetchColumn();

        return ['items' => $items, 'total' => $total];
    }
}
