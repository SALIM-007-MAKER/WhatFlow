<?php
namespace Controllers;
use Core\{Auth, Request, Response, Database};
use Models\AISuggestion;

class AnalyticsController {
    public function dashboard(): void {
        Auth::requireRole('super_admin', 'admin');
        $db = Database::getInstance();

        $convToday = (int) $db->query(
            'SELECT COUNT(*) FROM conversations WHERE DATE(opened_at) = CURDATE()'
        )->fetchColumn();

        $convActive = (int) $db->query(
            'SELECT COUNT(*) FROM conversations WHERE status != "closed"'
        )->fetchColumn();

        $resolutionRate = (float) $db->query(
            'SELECT ROUND(SUM(status="closed") / COUNT(*) * 100, 1) FROM conversations'
        )->fetchColumn();

        $avgResponseMin = (float) $db->query(
            'SELECT AVG(TIMESTAMPDIFF(MINUTE, c.opened_at, m.first_reply))
            FROM conversations c
            JOIN (
                SELECT conversation_id, MIN(sent_at) AS first_reply
                FROM messages WHERE sender_type = "agent"
                GROUP BY conversation_id
            ) m ON m.conversation_id = c.id
            WHERE m.first_reply >= c.opened_at'
        )->fetchColumn();

        $suggModel   = new AISuggestion();
        $aiAdoption  = $suggModel->adoptionRate();

        $byStatus = $db->query(
            'SELECT status, COUNT(*) AS count FROM conversations GROUP BY status'
        )->fetchAll();

        $byPriority = $db->query(
            'SELECT priority, COUNT(*) AS count FROM conversations GROUP BY priority'
        )->fetchAll();

        $last7Days = $db->query(
            'SELECT DATE(opened_at) AS date, COUNT(*) AS count
            FROM conversations
            WHERE opened_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
            GROUP BY DATE(opened_at)
            ORDER BY date'
        )->fetchAll();

        Response::json([
            'conversations_today'   => $convToday,
            'conversations_active'  => $convActive,
            'resolution_rate'       => $resolutionRate,
            'avg_response_minutes'  => round($avgResponseMin, 1),
            'ai_adoption_rate'      => $aiAdoption,
            'by_status'             => $byStatus,
            'by_priority'           => $byPriority,
            'last_7_days'           => $last7Days,
        ]);
    }

    public function agents(): void {
        Auth::requireRole('super_admin', 'admin');
        $db = Database::getInstance();

        $agents = $db->query(
            'SELECT u.id, u.name, u.status, u.max_conversations,
                COUNT(c.id) AS conversations_traitees,
                SUM(c.status != "closed") AS actives,
                ROUND(SUM(c.status != "closed") / u.max_conversations * 100) AS charge_pct
            FROM users u
            LEFT JOIN conversations c ON c.assigned_agent_id = u.id
            WHERE u.role = "agent"
            GROUP BY u.id
            ORDER BY u.name'
        )->fetchAll();

        Response::json($agents);
    }
}
