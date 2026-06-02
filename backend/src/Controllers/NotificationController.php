<?php
namespace Controllers;
use Core\{Auth, Response, Database};

class NotificationController {
    public function index(): void {
        $user  = Auth::require();
        $db    = Database::getInstance();
        $items = $db->query(
            "SELECT * FROM sse_events
            WHERE (target_user_id IS NULL OR target_user_id = ?)
              AND event_type NOT IN ('ping', 'agent:status')
            ORDER BY id DESC
            LIMIT 30",
            [$user['sub']]
        )->fetchAll();

        Response::json(array_reverse($items));
    }
}
