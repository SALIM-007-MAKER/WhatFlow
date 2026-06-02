<?php
namespace Controllers;
use Core\{Auth, Request, Response};
use Models\{Conversation, AuditLog};
use Services\{AssignmentService, AIService};
use Helpers\Validator;

class ConversationController {
    public function index(): void {
        $user = Auth::require();

        $filters = [];
        if ($s = Request::get('status'))   $filters['status']   = $s;
        if ($p = Request::get('priority')) $filters['priority'] = $p;
        if ($q = Request::get('search'))   $filters['search']   = $q;

        if ($user['role'] === 'agent') {
            $filters['agent_id'] = $user['sub'];
        } elseif ($agentId = Request::get('agent_id')) {
            $filters['agent_id'] = (int) $agentId;
        }

        $page    = max(1, (int) Request::get('page', 1));
        $perPage = min(50, max(1, (int) Request::get('per_page', 20)));

        $convModel = new Conversation();
        $result    = $convModel->all($filters, $page, $perPage);

        Response::paginated($result['items'], $result['total'], $page, $perPage);
    }

    public function show(): void {
        $user   = Auth::require();
        $id     = (int) Request::param('id');
        $convModel = new Conversation();
        $conv   = $convModel->findById($id);

        if (!$conv) Response::error('Conversation introuvable', 404);

        if ($user['role'] === 'agent' && $conv['assigned_agent_id'] != $user['sub']) {
            Response::error('Accès interdit', 403);
        }

        Response::json($conv);
    }

    public function updateStatus(): void {
        $user   = Auth::require();
        $id     = (int) Request::param('id');
        $data   = Request::body();

        $v = Validator::make($data, ['status' => 'required|in:new,assigned,ongoing,waiting,closed']);
        if ($v->fails()) Response::error($v->firstError());

        $convModel = new Conversation();
        $conv      = $convModel->findById($id);
        if (!$conv) Response::error('Conversation introuvable', 404);

        $convModel->updateStatus($id, $data['status']);

        broadcastEvent('conversation:updated', ['id' => $id, 'status' => $data['status']]);

        $auditLog = new AuditLog();
        $auditLog->log('conversation_status_updated', $user['sub'], 'conversation', $id, [
            'old_status' => $conv['status'],
            'new_status' => $data['status'],
        ]);

        Response::json(['id' => $id, 'status' => $data['status']]);
    }

    public function assign(): void {
        Auth::requireRole('super_admin', 'admin');
        $id   = (int) Request::param('id');
        $data = Request::body();

        $v = Validator::make($data, ['agent_id' => 'required']);
        if ($v->fails()) Response::error($v->firstError());

        $agentId   = (int) $data['agent_id'];
        $convModel = new Conversation();
        $conv      = $convModel->findById($id);
        if (!$conv) Response::error('Conversation introuvable', 404);

        $convModel->assign($id, $agentId);

        broadcastEvent('conversation:updated', [
            'id'                => $id,
            'status'            => 'assigned',
            'assigned_agent_id' => $agentId,
        ]);

        $user = Auth::user();
        $auditLog = new AuditLog();
        $auditLog->log('conversation_assigned', $user['sub'], 'conversation', $id, ['agent_id' => $agentId]);

        Response::json(['id' => $id, 'assigned_agent_id' => $agentId]);
    }

    public function close(): void {
        $user      = Auth::require();
        $id        = (int) Request::param('id');
        $convModel = new Conversation();
        $conv      = $convModel->findById($id);

        if (!$conv) Response::error('Conversation introuvable', 404);
        if ($user['role'] === 'agent' && $conv['assigned_agent_id'] != $user['sub']) {
            Response::error('Accès interdit', 403);
        }

        $convModel->updateStatus($id, 'closed');
        broadcastEvent('conversation:updated', ['id' => $id, 'status' => 'closed']);

        $auditLog = new AuditLog();
        $auditLog->log('conversation_closed', $user['sub'], 'conversation', $id);

        // Analyse IA en arrière-plan (non bloquante)
        ignore_user_abort(true);
        register_shutdown_function(function() use ($id) {
            $ai = new AIService();
            $ai->analyzeConversation($id);
        });

        Response::json(['id' => $id, 'status' => 'closed']);
    }

    public function updatePriority(): void {
        Auth::require();
        $id   = (int) Request::param('id');
        $data = Request::body();

        $v = Validator::make($data, ['priority' => 'required|in:low,normal,high,urgent']);
        if ($v->fails()) Response::error($v->firstError());

        $convModel = new Conversation();
        if (!$convModel->findById($id)) Response::error('Conversation introuvable', 404);

        $convModel->updatePriority($id, $data['priority']);
        broadcastEvent('conversation:updated', ['id' => $id, 'priority' => $data['priority']]);

        Response::json(['id' => $id, 'priority' => $data['priority']]);
    }

    public function typing(): void {
        $user     = Auth::require();
        $id       = (int) Request::param('id');
        $isTyping = (bool)(Request::body()['is_typing'] ?? true);

        broadcastEvent('agent:typing', [
            'conversation_id' => $id,
            'agent_id'        => $user['sub'],
            'agent_name'      => $user['name'],
            'is_typing'       => $isTyping,
        ]);

        Response::json(['ok' => true]);
    }

    public function bulk(): void {
        $user = Auth::require();
        $data = Request::body();

        $v = Validator::make($data, ['ids' => 'required', 'action' => 'required']);
        if ($v->fails()) Response::error($v->firstError());

        $ids = array_map('intval', (array)($data['ids'] ?? []));
        $ids = array_filter($ids, fn($id) => $id > 0);
        if (!$ids || count($ids) > 100) Response::error('Entre 1 et 100 conversations requises');

        $action    = $data['action'];
        $value     = $data['value']    ?? null;
        $convModel = new Conversation();
        $affected  = 0;

        switch ($action) {
            case 'close':
                $affected = $convModel->bulkUpdateStatus($ids, 'closed');
                foreach ($ids as $id) {
                    broadcastEvent('conversation:updated', ['id' => $id, 'status' => 'closed']);
                }
                break;

            case 'status':
                $allowed = ['new', 'ongoing', 'waiting', 'assigned'];
                if (!in_array($value, $allowed)) Response::error('Statut invalide');
                $affected = $convModel->bulkUpdateStatus($ids, $value);
                foreach ($ids as $id) {
                    broadcastEvent('conversation:updated', ['id' => $id, 'status' => $value]);
                }
                break;

            case 'assign':
                if (!$value || !ctype_digit((string)$value)) Response::error('agent_id invalide');
                $agentId  = (int)$value;
                $affected = $convModel->bulkAssign($ids, $agentId);
                foreach ($ids as $id) {
                    broadcastEvent('conversation:updated', ['id' => $id, 'status' => 'assigned', 'assigned_agent_id' => $agentId]);
                }
                break;

            case 'priority':
                $allowed = ['low', 'normal', 'high', 'urgent'];
                if (!in_array($value, $allowed)) Response::error('Priorité invalide');
                $affected = $convModel->bulkUpdatePriority($ids, $value);
                foreach ($ids as $id) {
                    broadcastEvent('conversation:updated', ['id' => $id, 'priority' => $value]);
                }
                break;

            default:
                Response::error('Action inconnue');
        }

        $auditLog = new AuditLog();
        $auditLog->log('bulk_action', $user['sub'], 'conversation', null, [
            'action'   => $action,
            'value'    => $value,
            'ids'      => $ids,
            'affected' => $affected,
        ]);

        Response::json(['affected' => $affected]);
    }

    public function updateTags(): void {
        Auth::require();
        $id   = (int) Request::param('id');
        $data = Request::body();
        $tags = array_values(array_filter((array)($data['tags'] ?? []), fn($t) => is_string($t) && $t !== ''));

        $convModel = new Conversation();
        if (!$convModel->findById($id)) Response::error('Conversation introuvable', 404);

        $convModel->updateTags($id, $tags);
        broadcastEvent('conversation:updated', ['id' => $id, 'tags' => $tags]);

        Response::json(['id' => $id, 'tags' => $tags]);
    }
}
