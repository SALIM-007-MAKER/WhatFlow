<?php
use Controllers\{
    AuthController, ConversationController, MessageController,
    ContactController, AgentController, AIController,
    AutoResponseController, AnalyticsController,
    WhatsAppController, SSEController,
    AuditLogController, AIConfigController, NotificationController,
    BridgeController, CannedResponseController, ExportController,
    TwoFactorController, WebhookConfigController, AssignmentRuleController
};

// ── Auth (public) ───────────────────────────────────────────────────────
$router->post('/api/auth/login',      [AuthController::class, 'login']);
$router->post('/api/auth/refresh',    [AuthController::class, 'refresh']);
$router->post('/api/auth/logout',     [AuthController::class, 'logout']);
$router->get ('/api/auth/me',         [AuthController::class, 'me']);
$router->put ('/api/auth/profile',    [AuthController::class, 'updateProfile']);
$router->put ('/api/auth/password',   [AuthController::class, 'changePassword']);

// ── Two-Factor Auth ──────────────────────────────────────────────────────
$router->post('/api/auth/2fa/verify',  [TwoFactorController::class, 'verify']);  // public — no JWT yet
$router->get ('/api/auth/2fa/status',  [TwoFactorController::class, 'status']);
$router->post('/api/auth/2fa/setup',   [TwoFactorController::class, 'setup']);
$router->post('/api/auth/2fa/enable',  [TwoFactorController::class, 'enable']);
$router->post('/api/auth/2fa/disable', [TwoFactorController::class, 'disable']);

// ── SSE ─────────────────────────────────────────────────────────────────
$router->post('/api/sse/token', [SSEController::class, 'issueToken']);
$router->get ('/api/sse',       [SSEController::class, 'stream']);

// ── Conversations ────────────────────────────────────────────────────────
$router->get ('/api/conversations',                [ConversationController::class, 'index']);
$router->put ('/api/conversations/bulk',           [ConversationController::class, 'bulk']);
$router->get ('/api/conversations/:id',            [ConversationController::class, 'show']);
$router->put ('/api/conversations/:id/status',     [ConversationController::class, 'updateStatus']);
$router->put ('/api/conversations/:id/priority',   [ConversationController::class, 'updatePriority']);
$router->put ('/api/conversations/:id/tags',       [ConversationController::class, 'updateTags']);
$router->post('/api/conversations/:id/assign',     [ConversationController::class, 'assign']);
$router->post('/api/conversations/:id/close',      [ConversationController::class, 'close']);
$router->post('/api/conversations/:id/typing',     [ConversationController::class, 'typing']);

// ── Messages ─────────────────────────────────────────────────────────────
$router->get ('/api/messages/search',              [MessageController::class, 'search']);
$router->get ('/api/conversations/:id/messages',   [MessageController::class, 'index']);
$router->post('/api/conversations/:id/messages',   [MessageController::class, 'send']);
$router->post('/api/conversations/:id/notes',      [MessageController::class, 'addNote']);
$router->post('/api/conversations/:id/media',      [MessageController::class, 'sendMedia']);

// ── Contacts ─────────────────────────────────────────────────────────────
$router->get   ('/api/contacts',                           [ContactController::class, 'index']);
$router->get   ('/api/contacts/:id',                       [ContactController::class, 'show']);
$router->get   ('/api/contacts/:id/conversations',         [ContactController::class, 'conversations']);
$router->get   ('/api/contacts/:id/notes',                 [ContactController::class, 'notes']);
$router->post  ('/api/contacts/:id/notes',                 [ContactController::class, 'addNote']);
$router->delete('/api/contacts/:id/notes/:noteId',         [ContactController::class, 'deleteNote']);
$router->post  ('/api/contacts/alias',                     [ContactController::class, 'saveAlias']);

// ── Agents ───────────────────────────────────────────────────────────────
$router->get   ('/api/agents',            [AgentController::class, 'index']);
$router->post  ('/api/agents',            [AgentController::class, 'create']);
$router->put   ('/api/agents/:id/status', [AgentController::class, 'updateStatus']);
$router->put   ('/api/agents/:id',        [AgentController::class, 'update']);
$router->delete('/api/agents/:id',        [AgentController::class, 'delete']);
$router->get   ('/api/agents/:id/stats',  [AgentController::class, 'stats']);

// ── IA ────────────────────────────────────────────────────────────────────
$router->post('/api/ai/suggest',              [AIController::class, 'suggest']);
$router->put ('/api/ai/suggestions/:id/used', [AIController::class, 'markUsed']);
$router->post('/api/ai/analyze/:id',          [AIController::class, 'analyze']);

// ── Templates de réponses ─────────────────────────────────────────────────
$router->get   ('/api/canned-responses',     [CannedResponseController::class, 'index']);
$router->post  ('/api/canned-responses',     [CannedResponseController::class, 'create']);
$router->put   ('/api/canned-responses/:id', [CannedResponseController::class, 'update']);
$router->delete('/api/canned-responses/:id', [CannedResponseController::class, 'delete']);

// ── Auto-réponses ─────────────────────────────────────────────────────────
$router->get   ('/api/auto-responses',     [AutoResponseController::class, 'index']);
$router->post  ('/api/auto-responses',     [AutoResponseController::class, 'create']);
$router->put   ('/api/auto-responses/:id', [AutoResponseController::class, 'update']);
$router->delete('/api/auto-responses/:id', [AutoResponseController::class, 'delete']);

// ── Analytics ─────────────────────────────────────────────────────────────
$router->get('/api/analytics/dashboard', [AnalyticsController::class, 'dashboard']);
$router->get('/api/analytics/agents',    [AnalyticsController::class, 'agents']);

// ── WhatsApp ──────────────────────────────────────────────────────────────
$router->get ('/api/whatsapp/status',   [WhatsAppController::class, 'status']);
$router->get ('/api/whatsapp/qr',       [WhatsAppController::class, 'qr']);
$router->post('/api/webhook/whatsapp',     [WhatsAppController::class, 'webhook']);
$router->post('/api/webhook/message-ack', [WhatsAppController::class, 'messageAck']);

// ── Audit Logs ────────────────────────────────────────────────────────────
$router->get('/api/audit-logs', [AuditLogController::class, 'index']);

// ── AI Config ─────────────────────────────────────────────────────────────
$router->get ('/api/ai/config',      [AIConfigController::class, 'show']);
$router->post('/api/ai/config/test', [AIConfigController::class, 'test']);

// ── Notifications ─────────────────────────────────────────────────────────
$router->get('/api/notifications', [NotificationController::class, 'index']);

// ── Bridge Control Panel ──────────────────────────────────────────────────
$router->get   ('/api/bridge/status',  [BridgeController::class, 'status']);
$router->post  ('/api/bridge/start',   [BridgeController::class, 'start']);
$router->post  ('/api/bridge/stop',    [BridgeController::class, 'stop']);
$router->post  ('/api/bridge/restart', [BridgeController::class, 'restart']);
$router->get   ('/api/bridge/logs',    [BridgeController::class, 'logs']);
$router->delete('/api/bridge/logs',    [BridgeController::class, 'clearLogs']);

// ── Export ────────────────────────────────────────────────────────────────
$router->get('/api/export/conversations', [ExportController::class, 'conversations']);

// ── Assignment Rules ──────────────────────────────────────────────────────
$router->get   ('/api/assignment-rules',              [AssignmentRuleController::class, 'index']);
$router->post  ('/api/assignment-rules',              [AssignmentRuleController::class, 'create']);
$router->post  ('/api/assignment-rules/reorder',      [AssignmentRuleController::class, 'reorder']);
$router->put   ('/api/assignment-rules/:id',          [AssignmentRuleController::class, 'update']);
$router->delete('/api/assignment-rules/:id',          [AssignmentRuleController::class, 'delete']);
$router->post  ('/api/assignment-rules/:id/test',     [AssignmentRuleController::class, 'test']);

// ── Webhooks ──────────────────────────────────────────────────────────────
$router->get   ('/api/webhooks',          [WebhookConfigController::class, 'index']);
$router->post  ('/api/webhooks',          [WebhookConfigController::class, 'create']);
$router->put   ('/api/webhooks/:id',      [WebhookConfigController::class, 'update']);
$router->delete('/api/webhooks/:id',      [WebhookConfigController::class, 'delete']);
$router->post  ('/api/webhooks/:id/test', [WebhookConfigController::class, 'test']);

// ── Internal (cron-callable, protected by BRIDGE_SECRET) ─────────────────
$router->post('/api/internal/sla-escalate', function () {
    $header = $_SERVER['HTTP_X_INTERNAL_SECRET'] ?? '';
    if (!$header || $header !== WHATSAPP_BRIDGE_SECRET) {
        Core\Response::error('Forbidden', 403);
    }
    $escalated = (new Services\SLAService())->escalateBreached();
    Core\Response::json(['escalated' => $escalated]);
});

// ── Health ────────────────────────────────────────────────────────────────
$router->get('/api/health', fn() => Core\Response::json(['ok' => true, 'php' => PHP_VERSION]));
