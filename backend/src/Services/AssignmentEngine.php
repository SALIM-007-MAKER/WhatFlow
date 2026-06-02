<?php
namespace Services;
use Core\Database;
use Models\{AssignmentRule, User};

/**
 * Evaluates assignment rules against a new conversation.
 *
 * Rule conditions:
 *   keyword  — message contains one of the comma-separated keywords (case-insensitive)
 *   language — detected language matches value (fr|en|es|ar|de|pt)
 *   schedule — current time falls within the specified days/hours
 *   any      — always matches (catch-all)
 *
 * Rule actions:
 *   assign_agent        — assign to a specific agent_id (skipped if agent offline)
 *   assign_least_loaded — pick least-loaded agent from all available, or from agent_ids list
 *   round_robin         — rotate through agent_ids by picking the least-recently assigned
 */
class AssignmentEngine {
    private Database       $db;
    private AssignmentRule $ruleModel;

    public function __construct() {
        $this->db        = Database::getInstance();
        $this->ruleModel = new AssignmentRule();
    }

    /**
     * Find the first matching active rule and return the resolved agent ID.
     * Returns null if no rule matches or no agent could be resolved.
     */
    public function evaluate(string $message): ?array {
        $rules = $this->ruleModel->allActive();

        foreach ($rules as $rule) {
            if (!$this->matchesConditions($rule['conditions'], $message)) continue;

            $agentId = $this->resolveAgent($rule['action']);
            if ($agentId === null) continue; // rule matched but no agent available — try next

            $this->ruleModel->incrementMatch($rule['id']);
            return ['agent_id' => $agentId, 'rule_id' => $rule['id'], 'rule_name' => $rule['name']];
        }

        return null;
    }

    // ── Condition evaluation ─────────────────────────────────────────────────

    private function matchesConditions(array $conditions, string $message): bool {
        $operator = strtoupper($conditions['operator'] ?? 'AND');
        $items    = $conditions['items'] ?? [];

        if (empty($items)) return true;

        foreach ($items as $item) {
            $hit = $this->evaluateItem($item, $message);
            if ($operator === 'OR'  && $hit)  return true;
            if ($operator === 'AND' && !$hit) return false;
        }

        return $operator === 'AND'; // AND: all passed; OR: none matched
    }

    private function evaluateItem(array $item, string $message): bool {
        return match ($item['type'] ?? '') {
            'keyword'  => $this->matchKeyword($item['value'] ?? '', $message),
            'language' => $this->detectLanguage($message) === ($item['value'] ?? ''),
            'schedule' => $this->matchSchedule($item['value'] ?? []),
            'any'      => true,
            default    => false,
        };
    }

    private function matchKeyword(string $pattern, string $text): bool {
        if ($pattern === '' || $text === '') return false;
        $haystack = mb_strtolower($text);

        foreach (array_filter(array_map('trim', explode(',', $pattern))) as $kw) {
            $kw = mb_strtolower($kw);
            if ($kw === '') continue;
            if (str_starts_with($kw, '/') && str_ends_with($kw, '/')) {
                $regex = substr($kw, 1, -1);
                if (@preg_match('/' . $regex . '/iu', $haystack)) return true;
            } else {
                if (mb_strpos($haystack, $kw) !== false) return true;
            }
        }
        return false;
    }

    private function matchSchedule(array $schedule): bool {
        try {
            $now = new \DateTime('now', new \DateTimeZone($schedule['timezone'] ?? 'UTC'));
        } catch (\Exception) {
            $now = new \DateTime('now');
        }

        $day  = strtolower($now->format('D')); // mon tue wed thu fri sat sun
        $time = $now->format('H:i');
        $days = $schedule['days'] ?? ['mon','tue','wed','thu','fri','sat','sun'];

        if (!in_array($day, $days, true)) return false;

        $from = $schedule['from'] ?? '00:00';
        $to   = $schedule['to']   ?? '23:59';
        return $time >= $from && $time <= $to;
    }

    /**
     * Lightweight language detector.
     * Returns ISO 639-1 code: ar | fr | es | de | pt | en (default)
     */
    public function detectLanguage(string $text): string {
        if ($text === '') return 'unknown';

        if (preg_match('/[\x{0600}-\x{06FF}]/u', $text)) return 'ar';

        $lower  = mb_strtolower($text);
        $scores = ['fr' => 0, 'es' => 0, 'de' => 0, 'pt' => 0, 'en' => 0];

        static $wordlists = [
            'fr' => ['bonjour','bonsoir','merci','aide','problème','comment','svp','besoin','voudrais','pouvez','salut','journée','faire','avoir','était','très','votre','notre','avec','pour','dans','mais','encore','aussi','toujours','jamais','déjà','maintenant','besoin'],
            'es' => ['hola','gracias','ayuda','problema','cómo','necesito','puedo','buenos','días','tardes','noches','favor','quiero','puede','tengo','también','cuando','donde','porque','todo','para','como','bien','mismo','tiene','hacer'],
            'de' => ['hallo','danke','hilfe','bitte','haben','nicht','auch','noch','aber','wenn','dann','hier','sein','kann','für','diese','sind','wird','eine','nach','mehr','über','auch','wurde','werden'],
            'pt' => ['olá','obrigado','ajuda','problema','preciso','tenho','pode','favor','quero','também','quando','onde','porque','tudo','para','esse','essa','está','mais','bem'],
            'en' => ['hello','hi','help','thanks','please','problem','need','have','this','that','with','from','your','what','how','can','would','could','about','there','they','been','will','want','good','know','here','sorry'],
        ];

        foreach ($wordlists as $lang => $words) {
            foreach ($words as $w) {
                if (mb_strpos($lower, $w) !== false) $scores[$lang]++;
            }
        }

        // Diacritic boosts
        if (preg_match('/[àâäéèêëîïôöùûüç]/u', $lower)) $scores['fr'] += 2;
        if (preg_match('/[ñ¿¡]/u', $lower))               $scores['es'] += 3;
        if (preg_match('/[üöäß]/u', $lower))               $scores['de'] += 2;
        if (preg_match('/[ãõç]/u', $lower))                $scores['pt'] += 2;

        arsort($scores);
        $top = key($scores);
        return current($scores) >= 2 ? $top : 'en';
    }

    // ── Agent resolution ─────────────────────────────────────────────────────

    private function resolveAgent(array $action): ?int {
        return match ($action['type'] ?? '') {
            'assign_agent'        => $this->resolveSpecificAgent($action),
            'assign_least_loaded' => $this->leastLoadedAgent(!empty($action['agent_ids']) ? array_map('intval', $action['agent_ids']) : null),
            'round_robin'         => $this->roundRobinAgent(array_map('intval', $action['agent_ids'] ?? [])),
            default               => null,
        };
    }

    private function resolveSpecificAgent(array $action): ?int {
        $agentId = (int) ($action['agent_id'] ?? 0);
        if (!$agentId) return null;

        $row = $this->db->query(
            "SELECT id, status FROM users WHERE id = ? AND role IN ('agent','admin','super_admin')",
            [$agentId]
        )->fetch();

        if (!$row || !in_array($row['status'] ?? '', ['available', 'busy'], true)) return null;

        if (isset($action['max_load'])) {
            if ($this->agentLoad($agentId) >= (int) $action['max_load']) return null;
        }

        return $agentId;
    }

    public function leastLoadedAgent(?array $agentIds = null): ?int {
        $sql    = "SELECT u.id, COUNT(c.id) AS load
                   FROM users u
                   LEFT JOIN conversations c
                       ON c.assigned_agent_id = u.id AND c.status NOT IN ('closed','new')
                   WHERE u.role IN ('agent','admin','super_admin')
                     AND u.status IN ('available','busy')";
        $params = [];

        if ($agentIds) {
            $ph      = implode(',', array_fill(0, count($agentIds), '?'));
            $sql    .= " AND u.id IN ($ph)";
            $params  = $agentIds;
        }

        $sql .= ' GROUP BY u.id ORDER BY load ASC LIMIT 1';
        $row  = $this->db->query($sql, $params)->fetch();
        return $row ? (int) $row['id'] : null;
    }

    private function roundRobinAgent(array $agentIds): ?int {
        if (empty($agentIds)) return null;

        // Among the specified agents, pick the one with the oldest last assignment
        $ph  = implode(',', array_fill(0, count($agentIds), '?'));
        $row = $this->db->query(
            "SELECT u.id
             FROM users u
             LEFT JOIN conversations c
                 ON c.assigned_agent_id = u.id AND c.status NOT IN ('closed')
             WHERE u.id IN ($ph)
               AND u.status IN ('available','busy')
             GROUP BY u.id
             ORDER BY MAX(c.opened_at) ASC NULLS FIRST, COUNT(c.id) ASC
             LIMIT 1",
            $agentIds
        )->fetch();

        return $row ? (int) $row['id'] : null;
    }

    private function agentLoad(int $agentId): int {
        return (int) $this->db->query(
            "SELECT COUNT(*) FROM conversations WHERE assigned_agent_id = ? AND status NOT IN ('closed','new')",
            [$agentId]
        )->fetchColumn();
    }
}
