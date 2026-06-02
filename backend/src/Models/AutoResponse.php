<?php
namespace Models;
use Core\Database;

class AutoResponse {
    private Database $db;

    public function __construct() {
        $this->db = Database::getInstance();
    }

    public function all(): array {
        return $this->db->query(
            'SELECT * FROM auto_responses ORDER BY priority DESC, id ASC'
        )->fetchAll();
    }

    public function active(): array {
        return $this->db->query(
            'SELECT * FROM auto_responses WHERE is_active = 1 ORDER BY priority DESC, id ASC'
        )->fetchAll();
    }

    public function create(array $data): int {
        return $this->db->insert('auto_responses', [
            'name'          => $data['name'],
            'trigger_type'  => $data['trigger_type'],
            'trigger_value' => $data['trigger_value'],
            'response_text' => $data['response_text'],
            'is_active'     => $data['is_active'] ?? 1,
            'priority'      => $data['priority'] ?? 0,
        ]);
    }

    public function update(int $id, array $data): bool {
        $allowed = array_intersect_key($data, array_flip([
            'name','trigger_type','trigger_value','response_text','is_active','priority'
        ]));
        if (empty($allowed)) return false;
        return $this->db->update('auto_responses', $allowed, 'id = ?', [$id]) > 0;
    }

    public function delete(int $id): bool {
        $this->db->query('DELETE FROM auto_responses WHERE id = ?', [$id]);
        return true;
    }

    public function findById(int $id): ?array {
        $row = $this->db->query('SELECT * FROM auto_responses WHERE id = ?', [$id])->fetch();
        return $row ?: null;
    }
}
