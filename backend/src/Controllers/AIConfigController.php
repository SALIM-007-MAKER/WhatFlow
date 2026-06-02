<?php
namespace Controllers;
use Core\{Auth, Response, Database};
use Models\AISuggestion;

class AIConfigController {
    public function show(): void {
        Auth::requireRole('super_admin');
        $db     = Database::getInstance();
        $hasKey = !empty(GEMINI_API_KEY);

        Response::json([
            'provider'          => 'Google Gemini',
            'model'             => AI_MODEL,
            'api_key_set'       => $hasKey,
            'api_key_hint'      => $hasKey ? '●●●●●●●● …' . substr(GEMINI_API_KEY, -4) : 'Non configurée (.env)',
            'max_tokens'        => AI_MAX_TOKENS,
            'total_suggestions' => (int) $db->query('SELECT COUNT(*) FROM ai_suggestions')->fetchColumn(),
            'adoption_rate'     => (new AISuggestion())->adoptionRate(),
        ]);
    }

    public function test(): void {
        Auth::requireRole('super_admin');
        if (empty(GEMINI_API_KEY)) {
            Response::json(['ok' => false, 'message' => 'GEMINI_API_KEY manquante dans .env']);
            return;
        }

        $url  = 'https://generativelanguage.googleapis.com/v1beta/models/' . AI_MODEL . ':generateContent?key=' . GEMINI_API_KEY;
        $body = json_encode([
            'contents'         => [['role' => 'user', 'parts' => [['text' => 'Hello']]]],
            'generationConfig' => ['maxOutputTokens' => 5],
        ]);

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $body,
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
            CURLOPT_TIMEOUT        => 10,
            CURLOPT_SSL_VERIFYPEER => APP_ENV !== 'development',
        ]);
        $response = curl_exec($ch);
        $code     = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        $detail = '';
        if ($code !== 200) {
            $err    = json_decode($response, true);
            $detail = $err['error']['message'] ?? $response;
        }

        Response::json([
            'ok'      => $code === 200,
            'status'  => $code,
            'message' => $code === 200 ? 'Connexion Gemini réussie ✓' : "Erreur $code : $detail",
        ]);
    }
}
