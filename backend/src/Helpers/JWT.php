<?php
namespace Helpers;

class JWT {
    public static function encode(array $payload, ?int $ttl = null): string {
        $header  = rtrim(base64_encode(json_encode(['alg'=>'HS256','typ'=>'JWT'])), '=');
        $payload['exp'] = time() + ($ttl ?? JWT_EXPIRES);
        $payload['iat'] = time();
        $body    = rtrim(base64_encode(json_encode($payload)), '=');
        $sig     = hash_hmac('sha256', "$header.$body", JWT_SECRET, true);
        return "$header.$body." . rtrim(base64_encode($sig), '=');
    }

    public static function decode(string $token): ?array {
        $parts = explode('.', $token);
        if (count($parts) !== 3) return null;
        [$header, $body, $sig] = $parts;
        $expected = rtrim(base64_encode(hash_hmac('sha256', "$header.$body", JWT_SECRET, true)), '=');
        if (!hash_equals($expected, $sig)) return null;
        $payload = json_decode(base64_decode($body), true);
        if (!$payload || $payload['exp'] < time()) return null;
        return $payload;
    }

    /**
     * Comme decode() mais accepte les tokens expirés depuis moins de $graceSecs secondes.
     * Utilisé uniquement par le endpoint /api/auth/refresh.
     */
    public static function decodeRefreshable(string $token, int $graceSecs = 300): ?array {
        $parts = explode('.', $token);
        if (count($parts) !== 3) return null;
        [$header, $body, $sig] = $parts;
        $expected = rtrim(base64_encode(hash_hmac('sha256', "$header.$body", JWT_SECRET, true)), '=');
        if (!hash_equals($expected, $sig)) return null;
        $payload = json_decode(base64_decode($body), true);
        if (!$payload) return null;
        if ($payload['exp'] < time() - $graceSecs) return null;
        return $payload;
    }
}
