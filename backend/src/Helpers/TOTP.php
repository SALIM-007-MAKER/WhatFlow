<?php
namespace Helpers;

class TOTP {
    private const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    public static function generateSecret(int $length = 32): string {
        $secret = '';
        for ($i = 0; $i < $length; $i++) {
            $secret .= self::BASE32[random_int(0, 31)];
        }
        return $secret;
    }

    public static function verify(string $secret, string $code, int $window = 1): bool {
        $code = preg_replace('/\s+/', '', $code);
        if (!preg_match('/^\d{6}$/', $code)) return false;
        $t = (int)floor(time() / 30);
        for ($i = -$window; $i <= $window; $i++) {
            if (self::hotp($secret, $t + $i) === $code) return true;
        }
        return false;
    }

    public static function otpauthUri(string $secret, string $email, string $issuer = 'WhatFlow'): string {
        return 'otpauth://totp/'
            . rawurlencode($issuer . ':' . $email)
            . '?secret='   . $secret
            . '&issuer='   . rawurlencode($issuer)
            . '&algorithm=SHA1&digits=6&period=30';
    }

    private static function hotp(string $secret, int $counter): string {
        $key     = self::base32Decode($secret);
        $payload = pack('N*', 0) . pack('N*', $counter);
        $hash    = hash_hmac('sha1', $payload, $key, true);
        $offset  = ord($hash[19]) & 0xf;
        $code    = (
            ((ord($hash[$offset])     & 0x7f) << 24) |
            ((ord($hash[$offset + 1]) & 0xff) << 16) |
            ((ord($hash[$offset + 2]) & 0xff) <<  8) |
            ((ord($hash[$offset + 3]) & 0xff))
        ) % 1_000_000;
        return str_pad((string)$code, 6, '0', STR_PAD_LEFT);
    }

    private static function base32Decode(string $encoded): string {
        $encoded = strtoupper(preg_replace('/[^A-Z2-7]/', '', $encoded));
        $buf = 0; $bufLen = 0; $out = '';
        foreach (str_split($encoded) as $char) {
            $pos = strpos(self::BASE32, $char);
            if ($pos === false) continue;
            $buf    = ($buf << 5) | $pos;
            $bufLen += 5;
            if ($bufLen >= 8) {
                $bufLen -= 8;
                $out .= chr(($buf >> $bufLen) & 0xff);
            }
        }
        return $out;
    }
}
