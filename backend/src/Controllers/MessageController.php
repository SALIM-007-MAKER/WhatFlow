<?php
namespace Controllers;
use Core\{Auth, Request, Response};
use Models\{Message, Conversation, AuditLog};
use Services\WhatsAppBridge;
use Helpers\Validator;

class MessageController {
    public function index(): void {
        $user   = Auth::require();
        $convId = (int) Request::param('id');

        $convModel = new Conversation();
        $conv      = $convModel->findById($convId);
        if (!$conv) Response::error('Conversation introuvable', 404);

        if ($user['role'] === 'agent' && $conv['assigned_agent_id'] != $user['sub']) {
            Response::error('Accès interdit', 403);
        }

        $perPage  = min(100, max(1, (int) Request::get('per_page', 50)));
        $beforeId = Request::get('before_id') !== null ? (int) Request::get('before_id') : null;

        $msgModel = new Message();

        if ($beforeId !== null) {
            // Cursor: load older messages before a given id (for infinite scroll)
            $items = $msgModel->before($convId, $beforeId, $perPage);
            Response::json($items);
        } else {
            // Initial load: latest perPage messages, ASC order
            $result = $msgModel->latest($convId, $perPage);
            Response::paginated($result['items'], $result['total'], 1, $perPage);
        }
    }

    public function send(): void {
        $user   = Auth::require();
        $convId = (int) Request::param('id');
        $data   = Request::body();

        $v = Validator::make($data, ['content' => 'required|min:1|max:4096']);
        if ($v->fails()) Response::error($v->firstError());

        $convModel = new Conversation();
        $conv      = $convModel->findById($convId);
        if (!$conv) Response::error('Conversation introuvable', 404);

        if ($user['role'] === 'agent' && $conv['assigned_agent_id'] != $user['sub']) {
            Response::error('Accès interdit', 403);
        }

        $msgModel = new Message();
        $msgId    = $msgModel->create([
            'conversation_id' => $convId,
            'sender_type'     => 'agent',
            'sender_id'       => $user['sub'],
            'type'            => 'text',
            'content'         => $data['content'],
            'status'          => 'sent',
        ]);

        $convModel->updateLastMessage($convId);

        if ($conv['status'] === 'assigned') {
            $convModel->updateStatus($convId, 'ongoing');
        }

        // Envoyer via WhatsApp bridge — JID prioritaire pour supporter @lid
        $bridge   = new WhatsAppBridge();
        $to       = $conv['whatsapp_jid'] ?? $conv['whatsapp_number'];
        $waResult = $bridge->sendMessage($to, $data['content']);
        $msgModel->updateStatus($msgId, $waResult['status']);
        if (!empty($waResult['whatsapp_id'])) {
            $msgModel->setWhatsAppId($msgId, $waResult['whatsapp_id']);
        }

        $msg = $msgModel->findById($msgId);

        broadcastEvent('message:new', array_merge($msg, ['agent_name' => $user['name']]));
        broadcastEvent('conversation:updated', [
            'id'              => $convId,
            'status'          => $conv['status'] === 'assigned' ? 'ongoing' : $conv['status'],
            'last_message_at' => date('Y-m-d H:i:s'),
        ]);

        $auditLog = new AuditLog();
        $auditLog->log('message_sent', $user['sub'], 'conversation', $convId);

        Response::json($msg, 201);
    }

    public function sendMedia(): void {
        $user   = Auth::require();
        $convId = (int) Request::param('id');

        if (empty($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
            Response::error('Fichier requis ou erreur d\'upload', 400);
        }

        $file    = $_FILES['file'];
        $maxSize = 16 * 1024 * 1024;
        if ($file['size'] > $maxSize) Response::error('Fichier trop volumineux (max 16 Mo)');

        // Types autorisés (côté serveur via mime_content_type)
        $allowedServer = [
            'image/jpeg','image/png','image/gif','image/webp','image/heic','image/heif',
            'video/mp4','video/3gpp','video/quicktime','video/webm','video/x-matroska',
            'audio/mpeg','audio/mp4','audio/ogg','audio/webm','audio/wav','audio/x-wav',
            'audio/aac','audio/flac','audio/x-m4a',
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ];
        // Types autorisés déclarés par le navigateur (browser-reported, utilisé en fallback)
        $allowedBrowser = array_merge($allowedServer, [
            'audio/webm','video/webm', // MediaRecorder
        ]);

        $mimeServer  = mime_content_type($file['tmp_name']) ?: '';
        $mimeBrowser = $file['type'] ?: '';

        if (!in_array($mimeServer, $allowedServer) && !in_array($mimeBrowser, $allowedBrowser)) {
            Response::error('Type de fichier non supporté (' . $mimeServer . ')');
        }

        // Utiliser le MIME serveur si reconnu, sinon le MIME navigateur
        $mimetype = in_array($mimeServer, $allowedServer) ? $mimeServer : $mimeBrowser;

        $convModel = new Conversation();
        $conv      = $convModel->findById($convId);
        if (!$conv) Response::error('Conversation introuvable', 404);
        if ($user['role'] === 'agent' && $conv['assigned_agent_id'] != $user['sub']) {
            Response::error('Accès interdit', 403);
        }

        // Enregistrer le fichier
        $uploadBase = dirname(__DIR__, 2) . DIRECTORY_SEPARATOR . 'public' . DIRECTORY_SEPARATOR . 'uploads';
        $subDir     = date('Y') . DIRECTORY_SEPARATOR . date('m');
        $uploadDir  = $uploadBase . DIRECTORY_SEPARATOR . $subDir;
        if (!is_dir($uploadDir)) mkdir($uploadDir, 0775, true);

        $ext      = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION)) ?: 'bin';
        $stored   = uniqid('wf_', true) . '.' . $ext;
        $fullPath = $uploadDir . DIRECTORY_SEPARATOR . $stored;
        move_uploaded_file($file['tmp_name'], $fullPath);

        $mediaUrl = '/WhatFlow/backend/public/uploads/' . str_replace(DIRECTORY_SEPARATOR, '/', $subDir) . '/' . $stored;

        // Déterminer le type de message — audio prioritaire si le navigateur dit audio/
        $isAudioIntent = str_starts_with($mimeBrowser, 'audio/');
        $msgType = str_starts_with($mimetype, 'image/') ? 'image'
                 : ($isAudioIntent || str_starts_with($mimetype, 'audio/') ? 'audio'
                 : (str_starts_with($mimetype, 'video/') ? 'video' : 'document'));

        $caption = trim($_POST['caption'] ?? '');

        $msgModel = new Message();
        $msgId    = $msgModel->create([
            'conversation_id' => $convId,
            'sender_type'     => 'agent',
            'sender_id'       => $user['sub'],
            'type'            => $msgType,
            'content'         => $caption,
            'media_url'       => $mediaUrl,
            'status'          => 'sent',
        ]);

        $convModel->updateLastMessage($convId);
        if ($conv['status'] === 'assigned') $convModel->updateStatus($convId, 'ongoing');

        // Envoyer via bridge — utiliser le MIME navigateur pour les vocaux (audio/webm)
        $bridgeMime = $isAudioIntent ? $mimeBrowser : $mimetype;
        $base64     = base64_encode(file_get_contents($fullPath));
        $bridge   = new WhatsAppBridge();
        $to       = $conv['whatsapp_jid'] ?? $conv['whatsapp_number'];
        $isVoice  = $isAudioIntent;
        $waResult = $bridge->sendMedia($to, $base64, $bridgeMime, $file['name'], $caption, $isVoice);
        $msgModel->updateStatus($msgId, $waResult['status']);
        if (!empty($waResult['whatsapp_id'])) {
            $msgModel->setWhatsAppId($msgId, $waResult['whatsapp_id']);
        }

        $msg = $msgModel->findById($msgId);
        broadcastEvent('message:new', array_merge($msg, ['agent_name' => $user['name']]));
        broadcastEvent('conversation:updated', [
            'id'              => $convId,
            'last_message_at' => date('Y-m-d H:i:s'),
        ]);

        Response::json($msg, 201);
    }

    public function search(): void {
        Auth::require();
        $q     = trim(Request::get('q', ''));
        $limit = min(20, max(1, (int) Request::get('limit', 12)));

        if (strlen($q) < 2) {
            Response::json([]);
            return;
        }

        $msgModel = new Message();
        Response::json($msgModel->search($q, $limit));
    }

    public function addNote(): void {
        $user   = Auth::require();
        $convId = (int) Request::param('id');
        $data   = Request::body();

        $v = Validator::make($data, ['content' => 'required|min:1']);
        if ($v->fails()) Response::error($v->firstError());

        $convModel = new Conversation();
        $conv      = $convModel->findById($convId);
        if (!$conv) Response::error('Conversation introuvable', 404);

        $msgModel = new Message();
        $msgId    = $msgModel->create([
            'conversation_id' => $convId,
            'sender_type'     => 'agent',
            'sender_id'       => $user['sub'],
            'type'            => 'note',
            'content'         => $data['content'],
            'status'          => 'sent',
        ]);

        $msg = $msgModel->findById($msgId);
        broadcastEvent('message:new', $msg);

        Response::json($msg, 201);
    }
}
