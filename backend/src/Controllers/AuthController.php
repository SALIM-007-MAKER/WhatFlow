<?php
namespace Controllers;
use Core\{Auth, Request, Response};
use Models\{User, AuditLog};
use Services\AssignmentService;
use Helpers\{JWT, RateLimiter, Validator};

class AuthController {
    public function login(): void {
        RateLimiter::check('auth.login', 5, 60);
        $data = Request::body();
        $v    = Validator::make($data, [
            'email'    => 'required|email',
            'password' => 'required|min:6',
        ]);
        if ($v->fails()) Response::error($v->firstError());

        $userModel = new User();
        $user      = $userModel->findByEmail($data['email']);

        if (!$user || !password_verify($data['password'], $user['password_hash'])) {
            Response::error('Email ou mot de passe incorrect', 401);
        }

        // If 2FA is enabled, return a short-lived pending token instead of a full JWT
        if (!empty($user['totp_enabled'])) {
            $pendingToken = JWT::encode([
                'sub'  => $user['id'],
                'type' => '2fa_pending',
            ], 300); // expires in 5 minutes
            Response::json(['requires_2fa' => true, 'pending_token' => $pendingToken]);
        }

        $token = JWT::encode([
            'sub'   => $user['id'],
            'email' => $user['email'],
            'role'  => $user['role'],
            'name'  => $user['name'],
        ]);

        $userModel->updateStatus($user['id'], 'available');

        $auditLog = new AuditLog();
        $auditLog->log('login', $user['id'], 'user', $user['id']);

        Response::json([
            'token' => $token,
            'user'  => [
                'id'    => $user['id'],
                'name'  => $user['name'],
                'email' => $user['email'],
                'role'  => $user['role'],
            ],
        ]);
    }

    public function logout(): void {
        $user = Auth::require();

        $userModel = new User();
        $userModel->updateStatus($user['sub'], 'offline');

        $auditLog = new AuditLog();
        $auditLog->log('logout', $user['sub'], 'user', $user['sub']);

        broadcastEvent('agent:status', ['id' => $user['sub'], 'status' => 'offline']);

        // Réassigner les conversations actives de l'agent qui se déconnecte
        $assignSvc = new AssignmentService();
        $assignSvc->reassignFromAgent((int) $user['sub']);

        Response::json(['message' => 'Déconnecté avec succès']);
    }

    public function refresh(): void {
        RateLimiter::check('auth.refresh', 20, 60);
        $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
        $token  = str_starts_with($header, 'Bearer ') ? substr($header, 7) : '';

        if (!$token) Response::error('Token manquant', 401);

        $payload = JWT::decodeRefreshable($token);
        if (!$payload) Response::error('Token invalide ou expiré depuis trop longtemps', 401);

        $userModel = new User();
        $user      = $userModel->findById($payload['sub']);
        if (!$user) Response::error('Utilisateur introuvable', 401);

        $newToken = JWT::encode([
            'sub'   => $user['id'],
            'email' => $user['email'],
            'role'  => $user['role'],
            'name'  => $user['name'],
        ]);

        Response::json(['token' => $newToken]);
    }

    public function me(): void {
        $user      = Auth::require();
        $userModel = new User();
        $profile   = $userModel->findById($user['sub']);
        if (!$profile) Response::error('Utilisateur introuvable', 404);
        Response::json($profile);
    }

    public function updateProfile(): void {
        $user = Auth::require();
        $data = Request::body();

        $v = Validator::make($data, ['name' => 'required|min:2']);
        if ($v->fails()) Response::error($v->firstError());

        $userModel = new User();
        $userModel->updateName($user['sub'], trim($data['name']));

        $auditLog = new AuditLog();
        $auditLog->log('profile_updated', $user['sub'], 'user', $user['sub']);

        Response::json(['name' => trim($data['name'])]);
    }

    public function changePassword(): void {
        RateLimiter::check('auth.password_change', 5, 300);
        $user = Auth::require();
        $data = Request::body();

        $v = Validator::make($data, [
            'current_password' => 'required',
            'new_password'     => 'required|min:8',
        ]);
        if ($v->fails()) Response::error($v->firstError());

        $userModel   = new User();
        $currentHash = $userModel->getPasswordHash($user['sub']);

        if (!$currentHash || !password_verify($data['current_password'], $currentHash)) {
            Response::error('Mot de passe actuel incorrect', 422);
        }

        if ($data['current_password'] === $data['new_password']) {
            Response::error('Le nouveau mot de passe doit être différent', 422);
        }

        $userModel->updatePassword($user['sub'], $data['new_password']);

        $auditLog = new AuditLog();
        $auditLog->log('password_changed', $user['sub'], 'user', $user['sub']);

        Response::json(['message' => 'Mot de passe modifié avec succès']);
    }
}
