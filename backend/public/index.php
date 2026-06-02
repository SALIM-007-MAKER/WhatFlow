<?php
require_once __DIR__ . '/../config/config.php';

spl_autoload_register(function (string $class): void {
    $file = __DIR__ . '/../src/' . str_replace('\\', '/', $class) . '.php';
    if (file_exists($file)) require_once $file;
});

// Webhook event queue — collected during the request, dispatched after response is sent
$_webhookQueue = [];

// Global helper — publishes an SSE event and queues for outbound webhooks
function broadcastEvent(string $type, array $payload, ?int $userId = null): void {
    global $_webhookQueue;
    try {
        \Core\Database::getInstance()->insert('sse_events', [
            'target_user_id' => $userId,
            'event_type'     => $type,
            'payload'        => json_encode($payload),
        ]);
    } catch (\Throwable $e) {
        error_log('broadcastEvent error: ' . $e->getMessage());
    }
    $_webhookQueue[] = ['type' => $type, 'payload' => $payload];
}

// Dispatch queued webhook events + SLA escalation after the response is sent
register_shutdown_function(function (): void {
    global $_webhookQueue;

    // Webhooks
    if (!empty($_webhookQueue)) {
        try {
            (new \Services\WebhookService())->dispatchBatch($_webhookQueue);
        } catch (\Throwable $e) {
            error_log('webhook dispatch error: ' . $e->getMessage());
        }
    }

    // SLA escalation — run on ~3 % of requests to avoid needing a cron job
    if (mt_rand(1, 100) <= 3) {
        try {
            (new \Services\SLAService())->escalateBreached();
        } catch (\Throwable $e) {
            error_log('SLA escalation error: ' . $e->getMessage());
        }
    }
});

// Set error handler to log instead of expose
set_error_handler(function (int $errno, string $errstr, string $file, int $line): bool {
    $msg = "PHP Error [$errno]: $errstr in $file:$line";
    error_log($msg);
    @file_put_contents(LOG_PATH . 'app.log', '[' . date('Y-m-d H:i:s') . '] [ERROR] ' . $msg . PHP_EOL, FILE_APPEND);
    return true;
});

set_exception_handler(function (\Throwable $e): void {
    $msg = get_class($e) . ': ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine();
    error_log($msg);
    @file_put_contents(LOG_PATH . 'app.log', '[' . date('Y-m-d H:i:s') . '] [EXCEPTION] ' . $msg . PHP_EOL, FILE_APPEND);
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json');
    }
    echo json_encode(['success' => false, 'error' => 'Erreur serveur interne']);
    exit;
});

// CORS
header('Access-Control-Allow-Origin: ' . FRONTEND_URL);
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Access-Control-Allow-Credentials: true');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

header('Content-Type: application/json');

$router = new Core\Router();
require_once __DIR__ . '/../src/routes.php';
$router->dispatch();
