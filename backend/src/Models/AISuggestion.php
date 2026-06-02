<?php
namespace Models;
use Core\Database;

class AISuggestion {
    private Database $db;

    public function __construct() {
        $this->db = Database::getInstance();
    }

    public function create(int $convId, string $text, ?float $confidence = null): int {
        return $this->db->insert('ai_suggestions', [
            'conversation_id'  => $convId,
            'suggestion_text'  => $text,
            'confidence_score' => $confidence,
        ]);
    }

    public function markUsed(int $id, bool $modified = false): void {
        $this->db->update('ai_suggestions', [
            'was_used'     => 1,
            'was_modified' => $modified ? 1 : 0,
        ], 'id = ?', [$id]);
    }

    public function byConversation(int $convId): array {
        return $this->db->query(
            'SELECT * FROM ai_suggestions WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 10',
            [$convId]
        )->fetchAll();
    }

    public function adoptionRate(): float {
        $row = $this->db->query(
            'SELECT ROUND(SUM(was_used) / COUNT(*) * 100, 1) AS rate FROM ai_suggestions'
        )->fetch();
        return (float) ($row['rate'] ?? 0);
    }
}
