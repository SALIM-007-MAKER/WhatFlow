<?php
namespace Controllers;
use Core\{Auth, Request, Response, Database};
use Helpers\Validator;
use Services\WebhookService;

class WebhookConfigController {

    private const ALLOWED_EVENTS = [
        'conversation:new', 'conversation:updated', 'conversation:closed',
        'message:new', 'agent:typing', 'agent:status',
    ];

    public function index(): void {
        Auth::requireRole('super_admin', 'admin');
        $rows = Database::getInstance()->query(
            'SELECT id, url, events, active, created_at, last_called, last_status FROM webhook_configs ORDER BY id DESC'
        )->fetchAll();
        foreach ($rows as &$r) {
            $r['events'] = json_decode($r['events'], true) ?? [];
        }
        Response::json($rows);
    }

    public function create(): void {
        Auth::requireRole('super_admin', 'admin');
        $data = Request::body();

        $v = Validator::make($data, ['url' => 'required', 'events' => 'required']);
        if ($v->fails()) Response::error($v->firstError());

        if (!filter_var($data['url'], FILTER_VALIDATE_URL)) {
            Response::error('URL invalide');
        }

        $events = array_values(array_intersect((array)$data['events'], self::ALLOWED_EVENTS));
        if (!$events) Response::error('Aucun événement valide sélectionné');

        $secret = bin2hex(random_bytes(32));
        $id = Database::getInstance()->insert('webhook_configs', [
            'url'    => $data['url'],
            'secret' => $secret,
            'events' => json_encode($events),
            'active' => 1,
        ]);

        Response::json(['id' => $id, 'secret' => $secret, 'url' => $data['url'], 'events' => $events, 'active' => true]);
    }

    public function update(): void {
        Auth::requireRole('super_admin', 'admin');
        $id   = (int) Request::param('id');
        $data = Request::body();
        $db   = Database::getInstance();

        $row = $db->query('SELECT id FROM webhook_configs WHERE id=?', [$id])->fetch();
        if (!$row) Response::error('Webhook introuvable', 404);

        $fields = [];
        if (isset($data['url'])) {
            if (!filter_var($data['url'], FILTER_VALIDATE_URL)) Response::error('URL invalide');
            $fields['url'] = $data['url'];
        }
        if (isset($data['events'])) {
            $events = array_values(array_intersect((array)$data['events'], self::ALLOWED_EVENTS));
            if (!$events) Response::error('Aucun événement valide');
            $fields['events'] = json_encode($events);
        }
        if (isset($data['active'])) {
            $fields['active'] = $data['active'] ? 1 : 0;
        }

        if ($fields) $db->update('webhook_configs', $fields, 'id=?', [$id]);
        Response::json(['id' => $id]);
    }

    public function delete(): void {
        Auth::requireRole('super_admin', 'admin');
        $id = (int) Request::param('id');
        Database::getInstance()->query('DELETE FROM webhook_configs WHERE id=?', [$id]);
        Response::json(['deleted' => true]);
    }

    public function test(): void {
        Auth::requireRole('super_admin', 'admin');
        $id  = (int) Request::param('id');
        $row = Database::getInstance()->query(
            'SELECT url, secret FROM webhook_configs WHERE id=?', [$id]
        )->fetch();
        if (!$row) Response::error('Webhook introuvable', 404);

        $svc    = new WebhookService();
        $status = $svc->sendTest($row['url'], $row['secret']);

        if ($status === 0)          Response::error('Impossible de joindre l\'URL (timeout ou connexion refusée)', 502);
        if ($status >= 400)         Response::error("L'endpoint a répondu avec le statut $status", 502);

        Response::json(['status' => $status, 'message' => 'Test réussi']);
    }
}
