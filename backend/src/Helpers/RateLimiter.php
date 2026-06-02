<?php
namespace Helpers;
use Core\{Database, Response};

class RateLimiter {
    /**
     * Vérifie et incrémente le compteur de requêtes pour l'IP courante.
     * Si la limite est dépassée, renvoie une réponse 429 et arrête l'exécution.
     *
     * @param string $endpoint  Clé unique de l'endpoint (ex: 'auth.login')
     * @param int    $maxHits   Nombre max de requêtes dans la fenêtre
     * @param int    $windowSecs Durée de la fenêtre en secondes
     */
    public static function check(string $endpoint, int $maxHits, int $windowSecs): void {
        $db          = Database::getInstance();
        $ip          = self::clientIp();
        $now         = time();
        $windowStart = $now - $windowSecs;

        // Atomic upsert: reset window if expired, else increment
        $db->query(
            'INSERT INTO rate_limits (ip, endpoint, hits, window_start)
             VALUES (?, ?, 1, ?)
             ON DUPLICATE KEY UPDATE
                 hits         = IF(window_start < ?, 1, hits + 1),
                 window_start = IF(window_start < ?, ?, window_start)',
            [$ip, $endpoint, $now, $windowStart, $windowStart, $now]
        );

        $row = $db->query(
            'SELECT hits FROM rate_limits WHERE ip = ? AND endpoint = ?',
            [$ip, $endpoint]
        )->fetch();

        if ($row && (int)$row['hits'] > $maxHits) {
            header('Retry-After: ' . $windowSecs);
            Response::error(
                'Trop de tentatives. Réessayez dans ' . ceil($windowSecs / 60) . ' minute(s).',
                429
            );
        }

        // Cleanup stale entries occasionally (1% probability)
        if (mt_rand(1, 100) === 1) {
            $db->query('DELETE FROM rate_limits WHERE window_start < ?', [$windowStart - 3600]);
        }
    }

    private static function clientIp(): string {
        foreach (['HTTP_X_FORWARDED_FOR', 'HTTP_X_REAL_IP', 'REMOTE_ADDR'] as $key) {
            $val = $_SERVER[$key] ?? '';
            if ($val) {
                // X-Forwarded-For peut contenir une liste — prendre le premier IP
                return trim(explode(',', $val)[0]);
            }
        }
        return '0.0.0.0';
    }
}
