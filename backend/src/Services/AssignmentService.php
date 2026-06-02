<?php
namespace Services;
use Models\{User, Conversation, AuditLog};
use Core\Database;

class AssignmentService {
    public function assign(int $conversationId): ?int {
        $db = Database::getInstance();

        // Fetch first inbound message for rule evaluation
        $msgRow  = $db->query(
            "SELECT content FROM messages
             WHERE conversation_id = ? AND sender_type = 'contact'
             ORDER BY id ASC LIMIT 1",
            [$conversationId]
        )->fetch();
        $message = $msgRow['content'] ?? '';

        $engine = new AssignmentEngine();

        // 1. Try rules engine
        $match   = $engine->evaluate($message);
        $agentId = $match['agent_id'] ?? null;
        $method  = $match ? 'rule:' . ($match['rule_name'] ?? $match['rule_id']) : null;

        // 2. Fallback: least-loaded available agent
        if ($agentId === null) {
            $agentId = $engine->leastLoadedAgent();
            $method  = 'fallback_least_loaded';
        }

        if ($agentId === null) {
            $this->notifyAdminNoAgent($conversationId);
            return null;
        }

        $userModel = new User();
        $agent     = $userModel->findById($agentId);

        $convModel = new Conversation();
        $convModel->assign($conversationId, $agentId);

        broadcastEvent('conversation:updated', [
            'id'                => $conversationId,
            'status'            => 'assigned',
            'assigned_agent_id' => $agentId,
            'agent_name'        => $agent['name'] ?? '',
        ]);

        $auditLog = new AuditLog();
        $auditLog->log('conversation_assigned', $agentId, 'conversation', $conversationId, [
            'agent_id' => $agentId,
            'method'   => $method,
        ]);

        return $agentId;
    }

    /**
     * Réassigne toutes les conversations actives d'un agent qui se déconnecte.
     * Tente d'affecter à un autre agent disponible ; si aucun n'est dispo,
     * remet la conversation dans la file d'attente (statut 'new').
     * Retourne le nombre de conversations traitées.
     */
    public function reassignFromAgent(int $agentId): int {
        $convModel = new Conversation();
        $convs     = $convModel->activeByAgent($agentId);

        if (empty($convs)) return 0;

        $auditLog = new AuditLog();
        $count    = 0;

        foreach ($convs as $row) {
            $convId  = (int) $row['id'];
            $newAgent = $this->assign($convId); // l'agent offline n'est plus dans getAvailableAgents()

            if ($newAgent === null) {
                // Aucun agent dispo → file d'attente
                $convModel->resetToQueue($convId);
                broadcastEvent('conversation:updated', [
                    'id'                => $convId,
                    'status'            => 'new',
                    'assigned_agent_id' => null,
                    'agent_name'        => null,
                ]);
                $auditLog->log('conversation_queued', $agentId, 'conversation', $convId, [
                    'reason' => 'agent_disconnected',
                ]);
            } else {
                $auditLog->log('conversation_reassigned', $agentId, 'conversation', $convId, [
                    'old_agent_id' => $agentId,
                    'new_agent_id' => $newAgent,
                    'reason'       => 'agent_disconnected',
                ]);
            }
            $count++;
        }

        if ($count > 0) {
            broadcastEvent('notification:admin', [
                'type'    => 'agent_disconnected_reassignment',
                'message' => "$count conversation(s) réassignée(s) suite à la déconnexion de l'agent #$agentId",
            ]);
        }

        return $count;
    }

    private function notifyAdminNoAgent(int $conversationId): void {
        broadcastEvent('notification:admin', [
            'type'            => 'no_agent_available',
            'conversation_id' => $conversationId,
            'message'         => 'Aucun agent disponible pour assigner la conversation #' . $conversationId,
        ]);
    }
}
