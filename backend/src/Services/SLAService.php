<?php
namespace Services;
use Core\Database;
use Models\{Conversation, AuditLog};

/**
 * SLA escalation rules (minutes waiting since last customer message):
 *   normal  → high    after  20 min
 *   high    → urgent  after  15 min
 *   urgent  → notify  every  10 min (priority stays urgent)
 */
class SLAService {
    private const RULES = [
        'normal' => ['next' => 'high',   'minutes' => 20],
        'high'   => ['next' => 'urgent', 'minutes' => 15],
        'urgent' => ['next' => null,     'minutes' => 10],  // notify only
    ];

    public function escalateBreached(): int {
        $db         = Database::getInstance();
        $convModel  = new Conversation();
        $auditLog   = new AuditLog();
        $escalated  = 0;

        foreach (self::RULES as $priority => $rule) {
            $cutoff = date('Y-m-d H:i:s', time() - $rule['minutes'] * 60);

            // Find open conversations with this priority, waiting on a customer reply
            $rows = $db->query(
                "SELECT c.id, c.priority,
                    (SELECT sender_type FROM messages
                     WHERE conversation_id = c.id
                     ORDER BY sent_at DESC LIMIT 1) AS last_sender,
                    (SELECT sent_at FROM messages
                     WHERE conversation_id = c.id
                     ORDER BY sent_at DESC LIMIT 1) AS last_msg_at
                 FROM conversations c
                 WHERE c.status != 'closed'
                   AND c.priority = ?
                   AND c.last_message_at < ?",
                [$priority, $cutoff]
            )->fetchAll();

            foreach ($rows as $row) {
                if ($row['last_sender'] !== 'contact') continue; // only escalate when waiting on agent

                if ($rule['next']) {
                    // Upgrade priority
                    $convModel->updatePriority($row['id'], $rule['next']);
                    broadcastEvent('conversation:updated', [
                        'id'       => $row['id'],
                        'priority' => $rule['next'],
                        'sla_escalated' => true,
                    ]);
                    $auditLog->log('sla_escalated', null, 'conversation', $row['id'], [
                        'from' => $priority,
                        'to'   => $rule['next'],
                    ]);
                    $escalated++;
                } else {
                    // Already urgent — notify admins
                    broadcastEvent('notification:admin', [
                        'message'         => "Conversation #" . $row['id'] . " est urgente sans réponse depuis " . $rule['minutes'] . " min.",
                        'conversation_id' => $row['id'],
                        'type'            => 'sla_breach',
                    ]);
                }
            }
        }

        return $escalated;
    }
}
