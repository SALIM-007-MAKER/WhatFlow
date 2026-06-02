<?php
namespace Services;
use Models\{AutoResponse, Message, Conversation};
use Services\WhatsAppBridge;

class AutoReplyService {
    public function check(string $messageText, int $conversationId): bool {
        $autoResponseModel = new AutoResponse();
        $rules = $autoResponseModel->active();

        foreach ($rules as $rule) {
            if ($this->matches($messageText, $rule)) {
                $this->sendAutoReply($rule['response_text'], $conversationId);
                return true;
            }
        }

        return false;
    }

    private function matches(string $text, array $rule): bool {
        $trigger = $rule['trigger_value'];
        return match ($rule['trigger_type']) {
            'contains'    => stripos($text, $trigger) !== false,
            'equals'      => strtolower(trim($text)) === strtolower($trigger),
            'starts_with' => stripos($text, $trigger) === 0,
            default       => false,
        };
    }

    private function sendAutoReply(string $responseText, int $conversationId): void {
        $msgModel  = new Message();
        $convModel = new Conversation();
        $bridge    = new WhatsAppBridge();

        $conv = $convModel->findById($conversationId);
        if (!$conv) return;

        $msgId = $msgModel->create([
            'conversation_id' => $conversationId,
            'sender_type'     => 'bot',
            'type'            => 'text',
            'content'         => $responseText,
            'status'          => 'sent',
        ]);

        $convModel->updateLastMessage($conversationId);

        $to = $conv['whatsapp_jid'] ?? $conv['whatsapp_number'];
        $bridge->sendMessage($to, $responseText);

        broadcastEvent('message:new', [
            'conversation_id' => $conversationId,
            'id'              => $msgId,
            'sender_type'     => 'bot',
            'content'         => $responseText,
            'sent_at'         => date('Y-m-d H:i:s'),
        ]);
    }
}
