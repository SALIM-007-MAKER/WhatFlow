<?php
namespace Core;

class Request {
    private static array $params = [];

    public static function setParams(array $params): void {
        self::$params = $params;
    }

    public static function param(string $key, mixed $default = null): mixed {
        return self::$params[$key] ?? $default;
    }

    public static function get(string $key, mixed $default = null): mixed {
        return $_GET[$key] ?? $default;
    }

    public static function post(string $key, mixed $default = null): mixed {
        return $_POST[$key] ?? $default;
    }

    public static function body(): array {
        static $body = null;
        if ($body === null) {
            $raw  = file_get_contents('php://input');
            $body = $raw ? (json_decode($raw, true) ?? []) : [];
        }
        return $body;
    }

    public static function input(string $key, mixed $default = null): mixed {
        return self::body()[$key] ?? $default;
    }

    public static function ip(): string {
        return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    }

    public static function all(): array {
        return array_merge($_GET, self::body());
    }
}
