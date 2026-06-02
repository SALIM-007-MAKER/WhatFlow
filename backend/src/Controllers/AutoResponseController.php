<?php
namespace Controllers;
use Core\{Auth, Request, Response};
use Models\AutoResponse;
use Helpers\Validator;

class AutoResponseController {
    public function index(): void {
        Auth::require();
        $model = new AutoResponse();
        Response::json($model->all());
    }

    public function create(): void {
        Auth::requireRole('super_admin', 'admin');
        $data = Request::body();

        $v = Validator::make($data, [
            'name'          => 'required|min:2|max:100',
            'trigger_type'  => 'required|in:contains,equals,starts_with',
            'trigger_value' => 'required|min:1|max:255',
            'response_text' => 'required|min:1',
        ]);
        if ($v->fails()) Response::error($v->firstError());

        $model = new AutoResponse();
        $id    = $model->create($data);

        Response::json($model->findById($id), 201);
    }

    public function update(): void {
        Auth::requireRole('super_admin', 'admin');
        $id   = (int) Request::param('id');
        $data = Request::body();

        $model = new AutoResponse();
        $rule  = $model->findById($id);
        if (!$rule) Response::error('Règle introuvable', 404);

        $model->update($id, $data);
        Response::json($model->findById($id));
    }

    public function delete(): void {
        Auth::requireRole('super_admin', 'admin');
        $id    = (int) Request::param('id');
        $model = new AutoResponse();
        $rule  = $model->findById($id);
        if (!$rule) Response::error('Règle introuvable', 404);
        $model->delete($id);
        Response::json(['deleted' => true, 'id' => $id]);
    }
}
