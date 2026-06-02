<?php
namespace Core;
use Helpers\JWT;

class Auth {
    public static function user(): ?array {
        // 1. Standard Bearer header (API calls)
        $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
        if (str_starts_with($header, 'Bearer ')) {
            return JWT::decode(substr($header, 7));
        }
        // 2. Short-lived SSE ticket (replaces JWT-in-URL)
        if ($ticket = ($_GET['ticket'] ?? null)) {
            return self::validateSseTicket($ticket);
        }
        // 3. Legacy URL token — kept for dev fallback only
        if ($token = ($_GET['token'] ?? null)) {
            return JWT::decode($token);
        }
        return null;
    }

    public static function require(): array {
        $user = self::user();
        if (!$user) Response::error('Non authentifié', 401);
        return $user;
    }

    public static function requireRole(string ...$roles): array {
        $user = self::require();
        if (!in_array($user['role'], $roles)) Response::error('Accès interdit', 403);
        return $user;
    }

    private static function validateSseTicket(string $ticket): ?array {
        $db  = Database::getInstance();
        $row = $db->query(
            'SELECT t.user_id, u.role, u.name, u.email
             FROM sse_tickets t
             JOIN users u ON u.id = t.user_id
             WHERE t.ticket = ? AND t.expires_at > NOW()
             LIMIT 1',
            [$ticket]
        )->fetch();
        if (!$row) return null;
        // Single-use: delete immediately after validation
        $db->query('DELETE FROM sse_tickets WHERE ticket = ?', [$ticket]);
        return [
            'sub'   => (int) $row['user_id'],
            'role'  => $row['role'],
            'name'  => $row['name'],
            'email' => $row['email'],
        ];
    }
}
