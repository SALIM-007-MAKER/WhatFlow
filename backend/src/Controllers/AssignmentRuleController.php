<?php
namespace Controllers;
use Core\{Auth, Request, Response};
use Models\AssignmentRule;
use Services\AssignmentEngine;
use Helpers\Validator;

class AssignmentRuleController {

    private const ALLOWED_CONDITION_TYPES = ['keyword', 'language', 'schedule', 'any'];
    private const ALLOWED_ACTION_TYPES    = ['assign_agent', 'assign_least_loaded', 'round_robin'];
    private const ALLOWED_LANGUAGES       = ['fr', 'en', 'es', 'ar', 'de', 'pt'];

    public function index(): void {
        Auth::requireRole('admin', 'super_admin');
        Response::json((new AssignmentRule())->all());
    }

    public function create(): void {
        $user = Auth::requireRole('admin', 'super_admin');
        $data = Request::body();

        $v = Validator::make($data, [
            'name'       => 'required|min:2|max:150',
            'conditions' => 'required',
            'action'     => 'required',
        ]);
        if ($v->fails()) Response::error($v->firstError());

        $conditions = $data['conditions'];
        $action     = $data['action'];

        $this->validateConditions($conditions);
        $this->validateAction($action);

        $id   = (new AssignmentRule())->create([
            'name'       => trim($data['name']),
            'priority'   => max(0, (int) ($data['priority'] ?? 0)),
            'active'     => (int) ($data['active'] ?? 1),
            'conditions' => $conditions,
            'action'     => $action,
            'created_by' => $user['sub'],
        ]);

        Response::json((new AssignmentRule())->find($id), 201);
    }

    public function update(): void {
        Auth::requireRole('admin', 'super_admin');
        $id   = (int) Request::param('id');
        $data = Request::body();

        $rule = (new AssignmentRule())->find($id);
        if (!$rule) Response::error('Règle introuvable', 404);

        if (isset($data['conditions'])) $this->validateConditions($data['conditions']);
        if (isset($data['action']))     $this->validateAction($data['action']);

        $fields = array_intersect_key($data, array_flip(['name','priority','active','conditions','action']));
        (new AssignmentRule())->update($id, $fields);

        Response::json((new AssignmentRule())->find($id));
    }

    public function delete(): void {
        Auth::requireRole('admin', 'super_admin');
        $id = (int) Request::param('id');

        $rule = (new AssignmentRule())->find($id);
        if (!$rule) Response::error('Règle introuvable', 404);

        (new AssignmentRule())->delete($id);
        Response::json(['deleted' => true]);
    }

    /** Reorder priorities in bulk: [{id, priority}, …] */
    public function reorder(): void {
        Auth::requireRole('admin', 'super_admin');
        $items = Request::body()['items'] ?? [];
        $model = new AssignmentRule();
        foreach ($items as $item) {
            if (isset($item['id'], $item['priority'])) {
                $model->update((int) $item['id'], ['priority' => (int) $item['priority']]);
            }
        }
        Response::json(['ok' => true]);
    }

    /** Test a rule against a sample message — returns match result + detected language */
    public function test(): void {
        Auth::requireRole('admin', 'super_admin');
        $id  = (int) Request::param('id');
        $msg = trim(Request::body()['message'] ?? '');

        $rule = (new AssignmentRule())->find($id);
        if (!$rule) Response::error('Règle introuvable', 404);

        $engine   = new AssignmentEngine();
        $lang     = $engine->detectLanguage($msg);

        // Manually evaluate this single rule
        $matched  = false;
        $agentId  = null;
        $operator = strtoupper($rule['conditions']['operator'] ?? 'AND');
        $items    = $rule['conditions']['items'] ?? [];

        // Simulate matchesConditions via the engine (reuse evaluate with only this rule)
        // We call evaluate with a fake "only this rule" scenario by testing each item
        $results = [];
        foreach ($items as $item) {
            $hit = match ($item['type'] ?? '') {
                'keyword'  => $this->testKeyword($item['value'] ?? '', $msg),
                'language' => $lang === ($item['value'] ?? ''),
                'schedule' => true, // schedule is time-dependent; always show as pass in test
                'any'      => true,
                default    => false,
            };
            $results[] = ['type' => $item['type'], 'value' => $item['value'] ?? null, 'matched' => $hit];
        }

        if (empty($results)) {
            $matched = true;
        } elseif ($operator === 'AND') {
            $matched = !in_array(false, array_column($results, 'matched'), true);
        } else {
            $matched = in_array(true, array_column($results, 'matched'), true);
        }

        if ($matched) {
            $engine2 = new AssignmentEngine();
            // Use leastLoadedAgent as proxy for the action resolution without incrementing
            $agentId = null;
            if (($rule['action']['type'] ?? '') === 'assign_least_loaded') {
                $ids     = !empty($rule['action']['agent_ids']) ? array_map('intval', $rule['action']['agent_ids']) : null;
                $agentId = $engine2->leastLoadedAgent($ids);
            } elseif (($rule['action']['type'] ?? '') === 'assign_agent') {
                $agentId = (int) ($rule['action']['agent_id'] ?? 0) ?: null;
            }
        }

        Response::json([
            'matched'           => $matched,
            'operator'          => $operator,
            'conditions'        => $results,
            'detected_language' => $lang,
            'would_assign'      => $agentId,
        ]);
    }

    // ── Validation helpers ───────────────────────────────────────────────────

    private function validateConditions(mixed $conditions): void {
        if (!is_array($conditions)) Response::error('conditions doit être un objet');
        $items = $conditions['items'] ?? [];
        foreach ($items as $item) {
            if (!in_array($item['type'] ?? '', self::ALLOWED_CONDITION_TYPES, true)) {
                Response::error('Type de condition invalide: ' . ($item['type'] ?? ''));
            }
            if (($item['type'] ?? '') === 'language'
                && !in_array($item['value'] ?? '', self::ALLOWED_LANGUAGES, true)) {
                Response::error('Langue non supportée: ' . ($item['value'] ?? ''));
            }
        }
    }

    private function validateAction(mixed $action): void {
        if (!is_array($action)) Response::error('action doit être un objet');
        if (!in_array($action['type'] ?? '', self::ALLOWED_ACTION_TYPES, true)) {
            Response::error('Type d\'action invalide: ' . ($action['type'] ?? ''));
        }
        if ($action['type'] === 'assign_agent' && empty($action['agent_id'])) {
            Response::error('agent_id requis pour l\'action assign_agent');
        }
        if ($action['type'] === 'round_robin' && empty($action['agent_ids'])) {
            Response::error('agent_ids requis pour l\'action round_robin');
        }
    }

    private function testKeyword(string $pattern, string $text): bool {
        if ($pattern === '' || $text === '') return false;
        $haystack = mb_strtolower($text);
        foreach (array_filter(array_map('trim', explode(',', $pattern))) as $kw) {
            $kw = mb_strtolower($kw);
            if ($kw === '') continue;
            if (str_starts_with($kw, '/') && str_ends_with($kw, '/')) {
                if (@preg_match('/' . substr($kw, 1, -1) . '/iu', $haystack)) return true;
            } elseif (mb_strpos($haystack, $kw) !== false) {
                return true;
            }
        }
        return false;
    }
}
