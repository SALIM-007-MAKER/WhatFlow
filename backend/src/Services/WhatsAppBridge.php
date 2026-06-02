<?php
namespace Services;
use Helpers\Logger;

class WhatsAppBridge {
    private string $baseUrl;
    private string $secret;

    public function __construct() {
        $this->baseUrl = WHATSAPP_BRIDGE_URL;
        $this->secret  = WHATSAPP_BRIDGE_SECRET;
    }

    public function getStatus(): array {
        $result = $this->get('/status');
        return $result ?? ['connected' => false, 'phone' => null];
    }

    public function getQR(): array {
        $result = $this->get('/qr');
        return $result ?? ['qr' => null];
    }

    /**
     * Retourne un tableau avec :
     *   success bool  — le message a été confirmé par les serveurs WhatsApp
     *   status  string — 'delivered'|'channel'|'unconfirmed'|'failed'
     *   error   string|null
     *   ack     string|null — niveau ACK WhatsApp (SERVER, DEVICE, READ, TIMEOUT…)
     */
    public function sendMessage(string $to, string $message): array {
        Logger::info('WhatsAppBridge::sendMessage', [
            'to'      => $to,
            'msg_len' => strlen($message),
        ]);

        $result   = null;
        $httpCode = $this->postWithCode('/send', ['to' => $to, 'message' => $message], $result);

        if ($result === null) {
            Logger::error('WhatsAppBridge: bridge injoignable', ['to' => $to]);
            return ['success' => false, 'status' => 'failed', 'error' => 'Bridge injoignable (timeout)', 'ack' => null];
        }

        $error = $result['error'] ?? null;
        $ack   = $result['ack']   ?? null;

        // 422 = canal WhatsApp (unidirectionnel — envoi structurellement impossible)
        if ($httpCode === 422) {
            Logger::warn('WhatsAppBridge: destination est un canal WhatsApp', ['to' => $to, 'error' => $error]);
            return ['success' => false, 'status' => 'channel', 'error' => $error, 'ack' => null];
        }

        // 502 = message envoyé mais non confirmé par WhatsApp Server (ACK timeout)
        if ($httpCode === 502) {
            Logger::warn('WhatsAppBridge: message non confirmé par WhatsApp Server', ['to' => $to, 'ack' => $ack]);
            return ['success' => false, 'status' => 'unconfirmed', 'error' => $error, 'ack' => $ack];
        }

        $ok = ($result['success'] ?? false) === true && $httpCode === 200;

        if ($ok) {
            Logger::info('WhatsAppBridge: envoi confirmé', ['to' => $to, 'ack' => $ack, 'chatId' => $result['chatId'] ?? null]);
            return ['success' => true, 'status' => 'delivered', 'error' => null, 'ack' => $ack, 'whatsapp_id' => $result['messageId'] ?? null];
        }

        Logger::error('WhatsAppBridge: envoi refusé', ['to' => $to, 'http' => $httpCode, 'error' => $error]);
        return ['success' => false, 'status' => 'failed', 'error' => $error, 'ack' => null];
    }

    public function sendMedia(string $to, string $base64, string $mimetype, string $filename, string $caption = '', bool $asVoice = false): array {
        Logger::info('WhatsAppBridge::sendMedia', ['to' => $to, 'mime' => $mimetype, 'asVoice' => $asVoice]);

        $result   = null;
        $httpCode = $this->postWithCode('/send-media', [
            'to'       => $to,
            'base64'   => $base64,
            'mimetype' => $mimetype,
            'filename' => $filename,
            'caption'  => $caption,
            'asVoice'  => $asVoice,
        ], $result, 30);

        if ($result === null) {
            Logger::error('WhatsAppBridge::sendMedia bridge injoignable', ['to' => $to]);
            return ['success' => false, 'status' => 'failed', 'error' => 'Bridge injoignable', 'ack' => null];
        }

        $ack = $result['ack'] ?? null;
        if ($httpCode === 200 && ($result['success'] ?? false)) {
            Logger::info('WhatsAppBridge::sendMedia confirmé', ['to' => $to, 'ack' => $ack]);
            return ['success' => true, 'status' => 'delivered', 'error' => null, 'ack' => $ack, 'whatsapp_id' => $result['messageId'] ?? null];
        }
        if ($httpCode === 502) {
            return ['success' => false, 'status' => 'unconfirmed', 'error' => $result['error'] ?? null, 'ack' => $ack];
        }
        Logger::error('WhatsAppBridge::sendMedia refusé', ['to' => $to, 'http' => $httpCode]);
        return ['success' => false, 'status' => 'failed', 'error' => $result['error'] ?? null, 'ack' => null];
    }

    private function get(string $path): ?array {
        $ch = curl_init($this->baseUrl . $path);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 5,
            CURLOPT_HTTPHEADER     => ['X-Bridge-Secret: ' . $this->secret],
        ]);
        $body = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($code !== 200 || !$body) return null;
        return json_decode($body, true);
    }

    private function post(string $path, array $data): ?array {
        $result = null;
        $this->postWithCode($path, $data, $result);
        return $result;
    }

    private function postWithCode(string $path, array $data, ?array &$decoded, int $timeout = 15): int {
        $ch = curl_init($this->baseUrl . $path);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => json_encode($data),
            CURLOPT_TIMEOUT        => $timeout,
            CURLOPT_HTTPHEADER     => [
                'Content-Type: application/json',
                'X-Bridge-Secret: ' . $this->secret,
            ],
        ]);
        $body = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        $decoded = $body ? json_decode($body, true) : null;
        return $code;
    }
}
