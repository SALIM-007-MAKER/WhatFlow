<?php
namespace Controllers;
use Core\{Auth, Database, Response};
use Helpers\{JWT, RateLimiter};

class ExportController {
    public function conversations(): void {
        $header  = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
        $raw     = str_starts_with($header, 'Bearer ') ? substr($header, 7) : '';
        $payload = $raw ? JWT::decode($raw) : null;
        if (!$payload) Response::error('Non authentifié', 401);

        RateLimiter::check('export.conversations', 10, 60);

        $db     = Database::getInstance();
        $where  = ['1=1'];
        $params = [];

        $from   = $_GET['from']      ?? null;
        $to     = $_GET['to']        ?? null;
        $status = $_GET['status']    ?? null;
        $agent  = isset($_GET['agent_id']) ? (int)$_GET['agent_id'] : null;

        if ($from)  { $where[] = 'c.created_at >= ?'; $params[] = $from . ' 00:00:00'; }
        if ($to)    { $where[] = 'c.created_at <= ?'; $params[] = $to   . ' 23:59:59'; }
        if ($status && $status !== 'all') { $where[] = 'c.status = ?'; $params[] = $status; }
        if ($agent) { $where[] = 'c.assigned_agent_id = ?'; $params[] = $agent; }

        $rows = $db->query(
            "SELECT
                c.id,
                COALESCE(ca.custom_name, ct.display_name, ct.whatsapp_number,
                    SUBSTRING_INDEX(ct.whatsapp_jid,'@',1)) AS contact,
                ct.whatsapp_number                             AS phone,
                c.status,
                c.priority,
                COALESCE(u.name, '')                           AS agent,
                (SELECT COUNT(*) FROM messages m
                 WHERE m.conversation_id = c.id AND m.type != 'note') AS messages,
                c.created_at,
                c.updated_at
             FROM conversations c
             JOIN contacts ct      ON ct.id = c.contact_id
             LEFT JOIN contact_aliases ca ON ca.contact_id = ct.id
             LEFT JOIN users u     ON u.id = c.assigned_agent_id
             WHERE " . implode(' AND ', $where) . "
             ORDER BY c.created_at DESC
             LIMIT 10000",
            $params
        )->fetchAll();

        $filename = 'conversations_' . date('Y-m-d') . '.csv';
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . $filename . '"');
        header('Cache-Control: no-store');

        $out = fopen('php://output', 'w');
        fwrite($out, "\xEF\xBB\xBF"); // UTF-8 BOM for Excel

        fputcsv($out, ['ID', 'Contact', 'Téléphone', 'Statut', 'Priorité', 'Agent', 'Messages', 'Créé le', 'Mis à jour']);
        foreach ($rows as $r) {
            fputcsv($out, [
                $r['id'], $r['contact'], $r['phone'], $r['status'],
                $r['priority'], $r['agent'], $r['messages'],
                $r['created_at'], $r['updated_at'],
            ]);
        }

        fclose($out);
        exit;
    }
}
