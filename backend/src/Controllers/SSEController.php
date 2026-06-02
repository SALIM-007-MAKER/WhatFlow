<?php
namespace Controllers;
use Core\{Auth, Database, Response};

class SSEController {
    public function issueToken(): void {
        $user   = Auth::require();
        $ticket = bin2hex(random_bytes(32)); // 64-char hex
        $db     = Database::getInstance();

        $db->query('DELETE FROM sse_tickets WHERE expires_at < NOW()');
        $db->insert('sse_tickets', [
            'ticket'     => $ticket,
            'user_id'    => $user['sub'],
            'expires_at' => date('Y-m-d H:i:s', time() + 30),
        ]);

        Response::json(['ticket' => $ticket]);
    }

    public function stream(): void {
        $user = Auth::require();

        header('Content-Type: text/event-stream');
        header('Cache-Control: no-cache');
        header('X-Accel-Buffering: no');
        header('Connection: keep-alive');

        if (ob_get_level()) ob_end_flush();

        $db      = Database::getInstance();
        $userId  = $user['sub'];
        $lastId  = (int) ($_GET['lastEventId'] ?? 0);

        echo "event: ping\ndata: {\"time\":\"" . date('Y-m-d H:i:s') . "\"}\n\n";
        flush();

        $maxDuration = 29;
        $start       = time();
        $idleUs      = 1000000; // 1s when no events

        while (!connection_aborted() && (time() - $start) < $maxDuration) {
            $events = $db->query(
                'SELECT * FROM sse_events
                WHERE id > ?
                AND (target_user_id IS NULL OR target_user_id = ?)
                AND (target_user_id IS NOT NULL OR created_at > DATE_SUB(NOW(), INTERVAL 5 MINUTE))
                AND (target_user_id IS NULL OR is_consumed = 0)
                ORDER BY id ASC
                LIMIT 20',
                [$lastId, $userId]
            )->fetchAll();

            foreach ($events as $event) {
                $lastId = $event['id'];
                echo "id: {$event['id']}\n";
                echo "event: {$event['event_type']}\n";
                echo "data: {$event['payload']}\n\n";
                flush();

                if ($event['target_user_id'] !== null) {
                    $db->update('sse_events', ['is_consumed' => 1], 'id = ?', [$event['id']]);
                }
            }

            // Adaptive polling: 100ms after activity, 1s when idle
            if (!empty($events)) {
                usleep(100000); // 100ms — more events likely
            } else {
                usleep($idleUs);
            }

            // Periodic cleanup (1-in-50 chance per loop)
            if (rand(1, 50) === 1) {
                $db->query(
                    'DELETE FROM sse_events WHERE target_user_id IS NULL AND created_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)'
                );
                $db->query(
                    'DELETE FROM sse_events WHERE is_consumed = 1 AND created_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)'
                );
            }
        }

        echo "event: ping\ndata: {\"reconnect\":true}\n\n";
        flush();
    }
}
