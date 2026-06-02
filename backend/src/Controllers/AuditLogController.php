<?php
namespace Controllers;
use Core\{Auth, Request, Response};
use Models\AuditLog;

class AuditLogController {
    public function index(): void {
        Auth::requireRole('super_admin');
        $page    = max(1, (int) Request::get('page', 1));
        $perPage = min(50, max(1, (int) Request::get('per_page', 30)));
        $filters = [];
        if ($a = Request::get('action'))    $filters['action']    = $a;
        if ($u = Request::get('user_id'))   $filters['user_id']   = (int) $u;
        if ($d = Request::get('date_from')) $filters['date_from'] = $d;

        $model  = new AuditLog();
        $result = $model->all($page, $perPage, $filters);
        Response::paginated($result['items'], $result['total'], $page, $perPage);
    }
}
