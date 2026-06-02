<?php
namespace Controllers;
use Core\{Auth, Request, Response, Database};
use Helpers\{JWT, TOTP, RateLimiter};
use Models\{User, AuditLog};

class TwoFactorController {

    // Step 1 — generate a secret + otpauth URI (not yet saved to DB)
    public function setup(): void {
        $user   = Auth::require();
        $secret = TOTP::generateSecret();
        $uri    = TOTP::otpauthUri($secret, $user['email']);
        Response::json(['secret' => $secret, 'uri' => $uri]);
    }

    // Step 2 — confirm OTP and persist secret → 2FA enabled
    public function enable(): void {
        $user = Auth::require();
        $data = Request::body();
        $secret = trim($data['secret'] ?? '');
        $code   = trim($data['code']   ?? '');

        if (!$secret || !$code) Response::error('Secret et code requis');
        if (!TOTP::verify($secret, $code)) Response::error('Code invalide — réessayez', 422);

        $db = Database::getInstance();
        $db->query(
            "UPDATE users SET totp_secret=?, totp_enabled=1, totp_enabled_at=NOW() WHERE id=?",
            [$secret, $user['sub']]
        );

        $auditLog = new AuditLog();
        $auditLog->log('2fa_enabled', $user['sub'], 'user', $user['sub']);

        Response::json(['enabled' => true]);
    }

    // Disable 2FA (requires valid OTP to prove possession)
    public function disable(): void {
        $user = Auth::require();
        $data = Request::body();
        $code = trim($data['code'] ?? '');

        if (!$code) Response::error('Code requis');

        $db  = Database::getInstance();
        $row = $db->query("SELECT totp_secret FROM users WHERE id=?", [$user['sub']])->fetch();
        if (!$row || !$row['totp_secret']) Response::error('2FA non activé', 400);
        if (!TOTP::verify($row['totp_secret'], $code)) Response::error('Code invalide', 422);

        $db->query("UPDATE users SET totp_secret=NULL, totp_enabled=0, totp_enabled_at=NULL WHERE id=?", [$user['sub']]);

        $auditLog = new AuditLog();
        $auditLog->log('2fa_disabled', $user['sub'], 'user', $user['sub']);

        Response::json(['enabled' => false]);
    }

    // Called during login when 2FA is required — verify OTP and return full JWT
    public function verify(): void {
        RateLimiter::check('auth.2fa_verify', 5, 60);
        $data  = Request::body();
        $token = trim($data['pending_token'] ?? '');
        $code  = trim($data['code']          ?? '');

        if (!$token || !$code) Response::error('Token et code requis');

        // Decode the pending (partial) token — allow slightly-expired tokens (clock skew)
        $payload = JWT::decodeRefreshable($token, 10);
        if (!$payload || ($payload['type'] ?? '') !== '2fa_pending') {
            Response::error('Session expirée — reconnectez-vous', 401);
        }

        $db  = Database::getInstance();
        $row = $db->query(
            "SELECT id, email, role, name, totp_secret FROM users WHERE id=?",
            [$payload['sub']]
        )->fetch();

        if (!$row || !$row['totp_secret']) Response::error('Compte introuvable', 401);
        if (!TOTP::verify($row['totp_secret'], $code)) Response::error('Code invalide', 422);

        $fullToken = JWT::encode([
            'sub'   => $row['id'],
            'email' => $row['email'],
            'role'  => $row['role'],
            'name'  => $row['name'],
        ]);

        Response::json([
            'token' => $fullToken,
            'user'  => ['id' => $row['id'], 'name' => $row['name'], 'email' => $row['email'], 'role' => $row['role']],
        ]);
    }

    // Return current 2FA status for the logged-in user
    public function status(): void {
        $user = Auth::require();
        $db   = Database::getInstance();
        $row  = $db->query("SELECT totp_enabled, totp_enabled_at FROM users WHERE id=?", [$user['sub']])->fetch();
        Response::json([
            'enabled'    => (bool)($row['totp_enabled'] ?? false),
            'enabled_at' => $row['totp_enabled_at'] ?? null,
        ]);
    }
}
