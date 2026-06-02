<?php
namespace Models;
use Core\Database;

class CannedResponse {
    private Database $db;

    public function __construct() {
        $this->db = Database::getInstance();
    }

    public function all(): array {
        return $this->db->query(
            'SELECT cr.*, u.name AS creator_name
             FROM canned_responses cr
             LEFT JOIN users u ON u.id = cr.created_by
             ORDER BY cr.shortcut ASC'
        )->fetchAll();
    }

    public function findById(int $id): ?array {
        $row = $this->db->query(
            'SELECT * FROM canned_responses WHERE id = ?', [$id]
        )->fetch();
        return $row ?: null;
    }

    public function create(array $data): int {
        return $this->db->insert('canned_responses', [
            'shortcut'   => strtolower(trim($data['shortcut'])),
            'title'      => trim($data['title']),
            'content'    => trim($data['content']),
            'created_by' => $data['created_by'] ?? null,
        ]);
    }

    public function update(int $id, array $data): bool {
        $fields = [];
        if (isset($data['shortcut'])) $fields['shortcut'] = strtolower(trim($data['shortcut']));
        if (isset($data['title']))    $fields['title']    = trim($data['title']);
        if (isset($data['content']))  $fields['content']  = trim($data['content']);
        if (empty($fields)) return false;
        return $this->db->update('canned_responses', $fields, 'id = ?', [$id]) > 0;
    }

    public function delete(int $id): bool {
        return $this->db->query('DELETE FROM canned_responses WHERE id = ?', [$id])->rowCount() > 0;
    }

    public function shortcutTaken(string $shortcut, int $excludeId = 0): bool {
        return (bool) $this->db->query(
            'SELECT 1 FROM canned_responses WHERE shortcut = ? AND id != ? LIMIT 1',
            [strtolower(trim($shortcut)), $excludeId]
        )->fetchColumn();
    }
}
