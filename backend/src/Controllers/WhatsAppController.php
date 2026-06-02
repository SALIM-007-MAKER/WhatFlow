<?php
namespace Controllers;
use Core\{Auth, Request, Response};
use Models\{Contact, Conversation, Message, AuditLog};
use Services\{WhatsAppBridge, AssignmentService, AutoReplyService, AIService};
use Helpers\Logger;

class WhatsAppController {
    public function status(): void {
        Auth::requireRole('super_admin', 'admin');
        $bridge = new WhatsAppBridge();
        Response::json($bridge->getStatus());
    }

    public function qr(): void {
        Auth::requireRole('super_admin', 'admin');
        $bridge = new WhatsAppBridge();
        Response::json($bridge->getQR());
    }

    public function messageAck(): void {
        $data   = Request::body();
        $secret = $data['secret'] ?? '';

        if ($secret !== WHATSAPP_BRIDGE_SECRET) {
            Response::error('Accès non autorisé', 401);
        }

        $waId = trim($data['whatsapp_message_id'] ?? '');
        $ack  = (int) ($data['ack_level'] ?? 0);

        if (!$waId || $ack < 3) {
            Response::json(['ok' => false]);
            return;
        }

        $msgModel = new Message();
        $msg      = $msgModel->findByWhatsAppId($waId);

        if ($msg && $msg['status'] !== 'read') {
            $msgModel->updateStatus($msg['id'], 'read');
            broadcastEvent('message:status', [
                'id'              => $msg['id'],
                'conversation_id' => $msg['conversation_id'],
                'status'          => 'read',
            ]);
        }

        Response::json(['ok' => true]);
    }

    public function webhook(): void {
        $data   = Request::body();
        $secret = $data['secret'] ?? $_POST['secret'] ?? '';

        if ($secret !== WHATSAPP_BRIDGE_SECRET) {
            Logger::warn('Webhook: secret invalide', [
                'ip'              => $_SERVER['REMOTE_ADDR'] ?? 'unknown',
                'secret_received' => substr($secret, 0, 6) . '…',
            ]);
            Response::error('Accès non autorisé', 401);
        }

        // Séparation JID (identifiant routage) et numéro (affichage / recherche)
        $jid      = $data['whatsapp_jid'] ?? '';
        $number   = preg_replace('/[^0-9]/', '', $data['whatsapp_number'] ?? '') ?: null;
        $body     = trim($data['body'] ?? '');
        $type     = $data['type'] ?? 'text';
        $msgId    = $data['messageId'] ?? null;
        $pushname = mb_substr(trim($data['pushname'] ?? ''), 0, 255);

        Logger::info('Webhook reçu', [
            'route'   => 'POST /api/webhook/whatsapp',
            'service' => 'whatsapp-bridge',
            'jid'     => $jid ?: '(vide)',
            'number'  => $number ?? '(null)',
            'type'    => $type,
            'msgId'   => $msgId,
            'bodyLen' => strlen($body),
        ]);

        if (!$jid) {
            Logger::error('Webhook: JID manquant', ['keys' => array_keys($data)]);
            Response::error('JID manquant');
        }

        try {
            $contactModel = new Contact();
            $contact      = $contactModel->firstOrCreate($jid, $number, $pushname);

            $contactUpdate = ['last_seen' => date('Y-m-d H:i:s')];
            if ($pushname && ($contact['display_name'] ?? '') !== $pushname) {
                $contactUpdate['display_name'] = $pushname;
                $contact['display_name']       = $pushname;
            }
            if ($number && empty($contact['whatsapp_number'])) {
                $contactUpdate['whatsapp_number'] = $number;
                $contact['whatsapp_number']       = $number;
            }
            $contactModel->update($contact['id'], $contactUpdate);

            $convModel = new Conversation();
            $conv      = $convModel->findOpenByContact($contact['id']);

            $isNew = false;
            if (!$conv) {
                $convId = $convModel->create($contact['id']);
                $conv   = $convModel->findById($convId);
                $isNew  = true;
            }

            $msgModel = new Message();
            $msgId_db = $msgModel->create([
                'conversation_id'     => $conv['id'],
                'sender_type'         => 'contact',
                'type'                => $type === 'chat' ? 'text' : $type,
                'content'             => $body,
                'whatsapp_message_id' => $msgId,
                'status'              => 'delivered',
            ]);

            $convModel->updateLastMessage($conv['id']);

            broadcastEvent('message:new', [
                'id'              => $msgId_db,
                'conversation_id' => $conv['id'],
                'sender_type'     => 'contact',
                'content'         => $body,
                'sent_at'         => date('Y-m-d H:i:s'),
                'contact'         => $contact,
            ]);

            if ($isNew) {
                broadcastEvent('conversation:new', array_merge($convModel->findById($conv['id']), ['contact' => $contact]));
                $assignSvc = new AssignmentService();
                $assignSvc->assign($conv['id']);
            }

            // Auto-réponse
            $autoReply = new AutoReplyService();
            $autoReply->check($body, $conv['id']);

            Logger::info('Webhook traité avec succès', [
                'conversation_id' => $conv['id'],
                'message_id'      => $msgId_db,
                'is_new_conv'     => $isNew,
            ]);

        } catch (\Throwable $e) {
            Logger::error('Webhook: exception non gérée', [
                'route'     => 'POST /api/webhook/whatsapp',
                'service'   => 'whatsapp-bridge',
                'jid'       => $jid,
                'exception' => get_class($e),
                'message'   => $e->getMessage(),
                'file'      => $e->getFile() . ':' . $e->getLine(),
                'trace'     => array_slice(
                    array_map(fn($f) => ($f['file'] ?? '?') . ':' . ($f['line'] ?? '?') . ' ' . ($f['class'] ?? '') . ($f['type'] ?? '') . ($f['function'] ?? ''),
                    $e->getTrace()),
                0, 10),
            ]);
            Response::error('Erreur interne du webhook: ' . $e->getMessage(), 500);
            return;
        }

        // Détection contenu sensible (non bloquant, après réponse)
        ignore_user_abort(true);
        register_shutdown_function(function() use ($body, $conv) {
            $ai = new AIService();
            if ($ai->detectSensitiveContent($body)) {
                broadcastEvent('notification:admin', [
                    'type'            => 'sensitive_content',
                    'conversation_id' => $conv['id'],
                    'message'         => 'Contenu sensible détecté dans la conversation #' . $conv['id'],
                ]);
            }
        });

        Response::json(['received' => true]);
    }
}
