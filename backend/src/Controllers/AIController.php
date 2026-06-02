<?php
namespace Controllers;
use Core\{Auth, Request, Response};
use Models\{Conversation, AISuggestion};
use Services\AIService;

class AIController {
    public function suggest(): void {
        $user = Auth::require();
        $data = Request::body();

        if (empty($data['conversation_id'])) Response::error('conversation_id requis');
        $convId = (int) $data['conversation_id'];

        $convModel = new Conversation();
        $conv      = $convModel->findById($convId);
        if (!$conv) Response::error('Conversation introuvable', 404);

        if ($user['role'] === 'agent' && $conv['assigned_agent_id'] != $user['sub']) {
            Response::error('Accès interdit', 403);
        }

        $ai          = new AIService();
        $suggestions = $ai->generateSuggestions($convId);

        Response::json(['suggestions' => $suggestions, 'conversation_id' => $convId]);
    }

    public function markUsed(): void {
        Auth::require();
        $id       = (int) Request::param('id');
        $modified = (bool) (Request::body()['modified'] ?? false);
        (new AISuggestion())->markUsed($id, $modified);
        Response::json(['ok' => true]);
    }

    public function analyze(): void {
        Auth::requireRole('super_admin', 'admin');
        $convId    = (int) Request::param('id');
        $convModel = new Conversation();
        $conv      = $convModel->findById($convId);
        if (!$conv) Response::error('Conversation introuvable', 404);

        $ai       = new AIService();
        $analysis = $ai->analyzeConversation($convId);

        Response::json($analysis);
    }
}
