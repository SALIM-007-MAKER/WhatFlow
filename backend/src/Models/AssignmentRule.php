<?php
namespace Models;
use Core\Database;

class AssignmentRule {
    private Database $db;

    public function __construct() {
        $this->db = Database::getInstance();
    }

    public function all(): array {
        $rows = $this->db->query(
            'SELECT r.*, u.name AS created_by_name
             FROM assignment_rules r
             LEFT JOIN users u ON u.id = r.created_by
             ORDER BY r.priority ASC, r.id ASC'
        )->fetchAll();
        return array_map([$this, 'decode'], $rows);
    }

    public function allActive(): array {
        $rows = $this->db->query(
            'SELECT * FROM assignment_rules WHERE active = 1 ORDER BY priority ASC, id ASC'
        )->fetchAll();
        return array_map([$this, 'decode'], $rows);
    }

    public function find(int $id): ?array {
        $row = $this->db->query('SELECT * FROM assignment_rules WHERE id = ?', [$id])->fetch();
        return $row ? $this->decode($row) : null;
    }

    public function create(array $data): int {
        return $this->db->insert('assignment_rules', [
            'name'       => $data['name'],
            'priority'   => (int) ($data['priority'] ?? 0),
            'active'     => (int) ($data['active'] ?? 1),
            'conditions' => json_encode($data['conditions']),
            'action'     => json_encode($data['action']),
            'created_by' => $data['created_by'] ?? null,
        ]);
    }

    public function update(int $id, array $data): bool {
        $fields = [];
        if (array_key_exists('name', $data))       $fields['name']       = $data['name'];
        if (array_key_exists('priority', $data))   $fields['priority']   = (int) $data['priority'];
        if (array_key_exists('active', $data))     $fields['active']     = (int) $data['active'];
        if (array_key_exists('conditions', $data)) $fields['conditions'] = json_encode($data['conditions']);
        if (array_key_exists('action', $data))     $fields['action']     = json_encode($data['action']);
        if (empty($fields)) return false;
        return $this->db->update('assignment_rules', $fields, 'id = ?', [$id]) >= 0;
    }

    public function delete(int $id): bool {
        return $this->db->query('DELETE FROM assignment_rules WHERE id = ?', [$id])->rowCount() > 0;
    }

    public function incrementMatch(int $id): void {
        $this->db->query(
            'UPDATE assignment_rules SET match_count = match_count + 1, last_matched_at = NOW() WHERE id = ?',
            [$id]
        );
    }

    private function decode(array $row): array {
        if (is_string($row['conditions'])) $row['conditions'] = json_decode($row['conditions'], true) ?? [];
        if (is_string($row['action']))     $row['action']     = json_decode($row['action'],     true) ?? [];
        return $row;
    }
}
