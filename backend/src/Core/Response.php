<?php
namespace Core;

class Response {
    public static function json(mixed $data, int $status = 200): void {
        http_response_code($status);
        echo json_encode(['success' => $status < 400, 'data' => $data], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    public static function error(string $message, int $status = 400): void {
        http_response_code($status);
        echo json_encode(['success' => false, 'error' => $message], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    public static function paginated(array $items, int $total, int $page, int $perPage): void {
        self::json([
            'items'    => $items,
            'total'    => $total,
            'page'     => $page,
            'per_page' => $perPage,
            'pages'    => (int) ceil($total / max(1, $perPage)),
        ]);
    }
}
