<?php
namespace Controllers;
use Core\{Auth, Database, Request, Response};
use Models\{Contact, Conversation};
use Helpers\Validator;

class ContactController {
    public function index(): void {
        Auth::require();
        $page    = max(1, (int) Request::get('page', 1));
        $perPage = min(50, max(1, (int) Request::get('per_page', 20)));
        $search  = Request::get('search', '');

        $contactModel = new Contact();
        $result       = $contactModel->all($page, $perPage, $search);

        Response::paginated($result['items'], $result['total'], $page, $perPage);
    }

    public function show(): void {
        Auth::require();
        $id = (int) Request::param('id');

        $contactModel = new Contact();
        $contact      = $contactModel->findById($id);
        if (!$contact) Response::error('Contact introuvable', 404);

        $convModel    = new Conversation();
        $conversations = $convModel->all(['contact_id' => $id], 1, 10);

        Response::json(array_merge($contact, ['conversations' => $conversations['items']]));
    }

    public function conversations(): void {
        Auth::require();
        $id = (int) Request::param('id');

        $contactModel = new Contact();
        if (!$contactModel->findById($id)) Response::error('Contact introuvable', 404);

        $convModel = new Conversation();
        Response::json($convModel->allByContact($id));
    }

    public function notes(): void {
        Auth::require();
        $id = (int) Request::param('id');

        $contactModel = new Contact();
        if (!$contactModel->findById($id)) Response::error('Contact introuvable', 404);

        $db = Database::getInstance();
        $notes = $db->query(
            'SELECT cn.id, cn.content, cn.created_at,
                    u.name AS agent_name, u.id AS agent_id
             FROM contact_notes cn
             JOIN users u ON u.id = cn.agent_id
             WHERE cn.contact_id = ?
             ORDER BY cn.created_at DESC',
            [$id]
        )->fetchAll();

        Response::json($notes);
    }

    public function addNote(): void {
        $user = Auth::require();
        $id   = (int) Request::param('id');
        $data = Request::body();

        $v = Validator::make($data, ['content' => 'required|min:1|max:2000']);
        if ($v->fails()) Response::error($v->firstError());

        $contactModel = new Contact();
        if (!$contactModel->findById($id)) Response::error('Contact introuvable', 404);

        $db     = Database::getInstance();
        $noteId = $db->insert('contact_notes', [
            'contact_id' => $id,
            'agent_id'   => $user['sub'],
            'content'    => trim($data['content']),
        ]);

        $note = $db->query(
            'SELECT cn.id, cn.content, cn.created_at,
                    u.name AS agent_name, u.id AS agent_id
             FROM contact_notes cn
             JOIN users u ON u.id = cn.agent_id
             WHERE cn.id = ?',
            [$noteId]
        )->fetch();

        Response::json($note, 201);
    }

    public function deleteNote(): void {
        $user   = Auth::require();
        $id     = (int) Request::param('id');
        $noteId = (int) Request::param('noteId');

        $db   = Database::getInstance();
        $note = $db->query('SELECT * FROM contact_notes WHERE id = ? AND contact_id = ?', [$noteId, $id])->fetch();
        if (!$note) Response::error('Note introuvable', 404);

        // Only note author or admin can delete
        if ($note['agent_id'] !== $user['sub'] && $user['role'] !== 'admin') {
            Response::error('Accès refusé', 403);
        }

        $db->query('DELETE FROM contact_notes WHERE id = ?', [$noteId]);
        Response::json(['deleted' => true]);
    }

    public function saveAlias(): void {
        $user = Auth::require();
        $data = Request::body();

        $v = Validator::make($data, [
            'contact_id'  => 'required',
            'custom_name' => 'required|min:1|max:150',
        ]);
        if ($v->fails()) Response::error($v->firstError());

        $contactId = (int) $data['contact_id'];
        $name      = trim($data['custom_name']);

        $contactModel = new Contact();
        $contact      = $contactModel->findById($contactId);
        if (!$contact) Response::error('Contact introuvable', 404);

        $contactModel->setAlias($contactId, $name, $user['sub']);

        // Diffuser la mise à jour en temps réel
        broadcastEvent('contact:renamed', [
            'contact_id'  => $contactId,
            'custom_name' => $name,
        ]);

        Response::json(['contact_id' => $contactId, 'custom_name' => $name]);
    }
}
