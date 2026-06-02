<?php
namespace Controllers;
use Core\{Auth, Request, Response};
use Models\{User, AuditLog};
use Services\AssignmentService;
use Helpers\Validator;

class AgentController {
    public function index(): void {
        Auth::require();
        $filters = [];
        if ($role = Request::get('role'))     $filters['role']   = $role;
        if ($status = Request::get('status')) $filters['status'] = $status;

        $userModel = new User();
        Response::json($userModel->all($filters));
    }

    public function updateStatus(): void {
        $currentUser = Auth::require();
        $id          = (int) Request::param('id');
        $data        = Request::body();

        if ($currentUser['sub'] !== $id) {
            Auth::requireRole('super_admin', 'admin');
        }

        $v = Validator::make($data, ['status' => 'required|in:available,busy,inactive,offline']);
        if ($v->fails()) Response::error($v->firstError());

        $userModel = new User();
        $user      = $userModel->findById($id);
        if (!$user) Response::error('Agent introuvable', 404);

        $userModel->updateStatus($id, $data['status']);

        broadcastEvent('agent:status', ['id' => $id, 'status' => $data['status'], 'name' => $user['name']]);

        $auditLog = new AuditLog();
        $auditLog->log('agent_status_updated', $currentUser['sub'], 'user', $id, ['status' => $data['status']]);

        // Réassigner les conversations si l'agent passe offline ou inactif
        if (in_array($data['status'], ['offline', 'inactive'])) {
            $assignSvc = new AssignmentService();
            $assignSvc->reassignFromAgent($id);
        }

        Response::json(['id' => $id, 'status' => $data['status']]);
    }

    public function create(): void {
        Auth::requireRole('super_admin', 'admin');
        $data = Request::body();

        $v = Validator::make($data, [
            'name'     => 'required|min:2|max:100',
            'email'    => 'required|email',
            'password' => 'required|min:6',
            'role'     => 'required|in:agent,admin,super_admin',
        ]);
        if ($v->fails()) Response::error($v->firstError());

        $userModel = new User();
        if ($userModel->findByEmail($data['email'])) {
            Response::error('Cet email est déjà utilisé', 409);
        }

        $id   = $userModel->create($data);
        $user = $userModel->findById($id);

        $auditLog = new AuditLog();
        $auditLog->log('agent_created', Auth::user()['sub'], 'user', $id);

        Response::json($user, 201);
    }

    public function update(): void {
        Auth::requireRole('super_admin', 'admin');
        $id        = (int) Request::param('id');
        $data      = Request::body();
        $userModel = new User();

        if (!$userModel->findById($id)) Response::error('Agent introuvable', 404);

        $v = Validator::make($data, [
            'name'              => 'min:2|max:100',
            'email'             => 'email',
            'role'              => 'in:agent,admin,super_admin',
            'max_conversations' => 'min:1',
        ]);
        if ($v->fails()) Response::error($v->firstError());

        $userModel->update($id, $data);

        $auditLog = new AuditLog();
        $auditLog->log('agent_updated', Auth::user()['sub'], 'user', $id);

        Response::json($userModel->findById($id));
    }

    public function delete(): void {
        Auth::requireRole('super_admin');
        $id        = (int) Request::param('id');
        $userModel = new User();

        if (!$userModel->findById($id)) Response::error('Agent introuvable', 404);

        $currentUser = Auth::user();
        if ($currentUser['sub'] === $id) Response::error('Impossible de supprimer votre propre compte', 400);

        $userModel->delete($id);

        $auditLog = new AuditLog();
        $auditLog->log('agent_deleted', $currentUser['sub'], 'user', $id);

        Response::json(['deleted' => true, 'id' => $id]);
    }

    public function stats(): void {
        Auth::requireRole('super_admin', 'admin');
        $id        = (int) Request::param('id');
        $userModel = new User();
        $stats     = $userModel->getAgentStats($id);
        if (!$stats) Response::error('Agent introuvable', 404);
        Response::json($stats);
    }
}
