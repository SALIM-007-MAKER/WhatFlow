<?php
namespace Models;
use Core\Database;

class User {
    private Database $db;

    public function __construct() {
        $this->db = Database::getInstance();
    }

    public function findByEmail(string $email): ?array {
        $row = $this->db->query('SELECT * FROM users WHERE email = ?', [$email])->fetch();
        return $row ?: null;
    }

    public function findById(int $id): ?array {
        $row = $this->db->query('SELECT id,name,email,role,status,max_conversations,created_at FROM users WHERE id = ?', [$id])->fetch();
        return $row ?: null;
    }

    public function all(array $filters = []): array {
        $where = ['1=1'];
        $params = [];
        if (isset($filters['role'])) {
            $where[] = 'role = ?';
            $params[] = $filters['role'];
        }
        if (isset($filters['status'])) {
            $where[] = 'status = ?';
            $params[] = $filters['status'];
        }
        $sql = 'SELECT id,name,email,role,status,max_conversations,created_at FROM users WHERE ' . implode(' AND ', $where) . ' ORDER BY name';
        return $this->db->query($sql, $params)->fetchAll();
    }

    public function updateStatus(int $id, string $status): bool {
        return $this->db->update('users', ['status' => $status], 'id = ?', [$id]) > 0;
    }

    public function create(array $data): int {
        return $this->db->insert('users', [
            'name'              => $data['name'],
            'email'             => $data['email'],
            'password_hash'     => password_hash($data['password'], PASSWORD_BCRYPT, ['cost' => 12]),
            'role'              => $data['role'] ?? 'agent',
            'status'            => 'offline',
            'max_conversations' => $data['max_conversations'] ?? 10,
        ]);
    }

    public function getAgentStats(int $agentId): array {
        $row = $this->db->query(
            'SELECT u.id, u.name, u.status, u.max_conversations,
                COUNT(c.id) AS total_conversations,
                SUM(c.status != "closed") AS active_conversations
            FROM users u
            LEFT JOIN conversations c ON c.assigned_agent_id = u.id
            WHERE u.id = ?
            GROUP BY u.id',
            [$agentId]
        )->fetch();
        return $row ?: [];
    }

    public function updateName(int $id, string $name): bool {
        return $this->db->update('users', ['name' => $name], 'id = ?', [$id]) > 0;
    }

    public function updatePassword(int $id, string $newPassword): bool {
        $hash = password_hash($newPassword, PASSWORD_BCRYPT, ['cost' => 12]);
        return $this->db->update('users', ['password_hash' => $hash], 'id = ?', [$id]) > 0;
    }

    public function getPasswordHash(int $id): ?string {
        $row = $this->db->query('SELECT password_hash FROM users WHERE id = ?', [$id])->fetch();
        return $row ? $row['password_hash'] : null;
    }

    public function update(int $id, array $data): bool {
        $allowed = array_intersect_key($data, array_flip([
            'name', 'email', 'role', 'status', 'max_conversations',
        ]));
        if (isset($data['password']) && $data['password'] !== '') {
            $allowed['password_hash'] = password_hash($data['password'], PASSWORD_BCRYPT, ['cost' => 12]);
        }
        if (empty($allowed)) return false;
        return $this->db->update('users', $allowed, 'id = ?', [$id]) > 0;
    }

    public function delete(int $id): bool {
        $this->db->query('DELETE FROM users WHERE id = ?', [$id]);
        return true;
    }

    public function getAvailableAgents(): array {
        return $this->db->query(
            'SELECT u.id, u.name, u.max_conversations,
                COUNT(c.id) AS active_conversations
            FROM users u
            LEFT JOIN conversations c ON c.assigned_agent_id = u.id AND c.status != "closed"
            WHERE u.role = "agent" AND u.status = "available"
            GROUP BY u.id
            HAVING active_conversations < u.max_conversations
            ORDER BY active_conversations ASC'
        )->fetchAll();
    }
}
