<?php
namespace Services;
use Models\{Message, AISuggestion, AuditLog, Conversation};
use Helpers\Logger;

class AIService {
    private const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';

    private function call(string $systemPrompt, string $userMessage, int $maxTokens = 1000): ?string {
        $url  = self::BASE_URL . AI_MODEL . ':generateContent?key=' . GEMINI_API_KEY;
        $body = json_encode([
            'system_instruction' => [
                'parts' => [['text' => $systemPrompt]],
            ],
            'contents' => [
                ['role' => 'user', 'parts' => [['text' => $userMessage]]],
            ],
            'generationConfig' => [
                'maxOutputTokens' => $maxTokens,
                'temperature'     => 0.7,
            ],
        ]);

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER  => true,
            CURLOPT_POST            => true,
            CURLOPT_POSTFIELDS      => $body,
            CURLOPT_HTTPHEADER      => ['Content-Type: application/json'],
            CURLOPT_TIMEOUT         => 30,
            CURLOPT_SSL_VERIFYPEER  => APP_ENV !== 'development',
        ]);
        $response = curl_exec($ch);
        $code     = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($code !== 200) {
            Logger::error("Gemini API $code: $response");
            return null;
        }

        $data = json_decode($response, true);
        return $data['candidates'][0]['content']['parts'][0]['text'] ?? null;
    }

    public function generateSuggestions(int $conversationId): array {
        $msgs = array_reverse((new Message())->lastN($conversationId, 10));
        if (empty($msgs)) return [];

        $history = '';
        foreach ($msgs as $m) {
            $role     = $m['sender_type'] === 'contact' ? 'Client' : 'Agent';
            $history .= "$role: {$m['content']}\n";
        }

        $system = 'Tu es un agent de support client professionnel. Génère 2 suggestions de réponse concises et utiles basées sur la conversation. Réponds UNIQUEMENT en JSON valide: {"suggestions": ["...", "..."]}';
        $result = $this->call($system, "Conversation:\n$history\nGénère 2 suggestions de réponse.");

        if (!$result) return [];

        $decoded     = $this->parseJson($result, 'generateSuggestions');
        $suggestions = $decoded['suggestions'] ?? [];

        if (!is_array($suggestions)) {
            Logger::error("AIService::generateSuggestions — 'suggestions' n'est pas un tableau");
            return [];
        }

        // Garder uniquement les strings non vides, max 2
        $suggestions = array_values(array_filter(
            array_slice($suggestions, 0, 2),
            fn($s) => is_string($s) && trim($s) !== ''
        ));

        $suggModel = new AISuggestion();
        $result    = [];
        foreach ($suggestions as $s) {
            $id       = $suggModel->create($conversationId, $s);
            $result[] = ['id' => $id, 'text' => $s];
        }

        return $result;
    }

    public function analyzeConversation(int $conversationId): array {
        $msgs = array_reverse((new Message())->lastN($conversationId, 20));
        if (empty($msgs)) return [];

        $history = '';
        foreach ($msgs as $m) {
            $role     = $m['sender_type'] === 'contact' ? 'Client' : 'Agent';
            $history .= "$role: {$m['content']}\n";
        }

        $system = 'Analyse cette conversation de support client. Réponds UNIQUEMENT en JSON: {"sentiment": "positive|neutral|negative", "summary": "résumé en 1 phrase", "intent": "intention principale du client", "quality_score": 8.5}';
        $result = $this->call($system, "Conversation à analyser:\n$history", 300);

        if (!$result) return [];

        $analysis = $this->parseJson($result, 'analyzeConversation');
        if (empty($analysis)) return [];

        // Valider les clés attendues
        $valid = array_intersect_key($analysis, array_flip(['sentiment', 'summary', 'intent', 'quality_score']));
        if (empty($valid)) {
            Logger::error("AIService::analyzeConversation — réponse JSON manque les clés attendues");
            return [];
        }

        (new Conversation())->updateAnalysis($conversationId, $valid);
        (new AuditLog())->log('ai_analysis', null, 'conversation', $conversationId, $valid);

        return $valid;
    }

    public function detectSensitiveContent(string $text): bool {
        $system = 'Détecte si ce message contient du contenu sensible (insultes, menaces, données personnelles sensibles, urgences). Réponds UNIQUEMENT avec: {"sensitive": true} ou {"sensitive": false}';
        $result = $this->call($system, $text, 50);

        if (!$result) return false;

        $decoded = $this->parseJson($result, 'detectSensitiveContent');
        return ($decoded['sensitive'] ?? false) === true;
    }

    /**
     * Extrait et décode du JSON depuis une réponse Gemini.
     * Gère les code fences markdown et logue les erreurs de parsing.
     */
    private function parseJson(string $raw, string $caller): array {
        // Extraire le JSON même entouré de ```json ... ```
        if (preg_match('/```(?:json)?\s*(\{.*?\})\s*```/s', $raw, $m)) {
            $raw = $m[1];
        } elseif (preg_match('/(\{.*\})/s', $raw, $m)) {
            $raw = $m[1];
        }

        $decoded = json_decode($raw, true);

        if (json_last_error() !== JSON_ERROR_NONE) {
            Logger::error("AIService::$caller — JSON invalide (" . json_last_error_msg() . "): " . substr($raw, 0, 200));
            return [];
        }

        if (!is_array($decoded)) {
            Logger::error("AIService::$caller — json_decode n'a pas retourné un tableau");
            return [];
        }

        return $decoded;
    }
}
