<?php
namespace Services;
use Core\Database;

class WebhookService {
    private Database $db;

    public function __construct() {
        $this->db = Database::getInstance();
    }

    /**
     * Dispatch a batch of events to all matching active webhooks.
     * Called from a shutdown function — response is already sent to the client.
     *
     * @param list<array{type:string, payload:array}> $events
     */
    public function dispatchBatch(array $events): void {
        if (!$events) return;

        $configs = $this->db->query(
            'SELECT id, url, secret, events FROM webhook_configs WHERE active = 1'
        )->fetchAll();

        if (!$configs) return;

        foreach ($configs as $config) {
            $subscribed = json_decode($config['events'], true) ?? [];
            foreach ($events as $ev) {
                if (in_array($ev['type'], $subscribed, true)) {
                    $status = $this->send($config['url'], $config['secret'], $ev['type'], $ev['payload']);
                    $this->db->query(
                        'UPDATE webhook_configs SET last_called=NOW(), last_status=? WHERE id=?',
                        [$status, $config['id']]
                    );
                    break; // one HTTP call per webhook per batch (contains all matching events)
                }
            }
        }
    }

    /**
     * Send a test payload to a specific URL.
     * Returns the HTTP status code (0 = connection error).
     */
    public function sendTest(string $url, string $secret): int {
        return $this->send($url, $secret, 'webhook.test', [
            'message' => 'WhatFlow webhook test',
            'timestamp' => time(),
        ]);
    }

    private function send(string $url, string $secret, string $event, array $payload): int {
        $body = json_encode([
            'event'     => $event,
            'data'      => $payload,
            'timestamp' => time(),
        ]);

        $sig = 'sha256=' . hash_hmac('sha256', $body, $secret);

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $body,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 5,
            CURLOPT_CONNECTTIMEOUT => 3,
            CURLOPT_HTTPHEADER     => [
                'Content-Type: application/json',
                'X-WhatFlow-Signature: ' . $sig,
                'X-WhatFlow-Event: ' . $event,
                'User-Agent: WhatFlow-Webhook/1.0',
            ],
        ]);

        curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        return $status;
    }
}
