<?php
namespace Controllers;
use Core\{Auth, Request, Response};
use Models\CannedResponse;
use Helpers\Validator;

class CannedResponseController {

    public function index(): void {
        Auth::require();
        $model = new CannedResponse();
        Response::json($model->all());
    }

    public function create(): void {
        $user = Auth::requireRole('super_admin', 'admin');
        $data = Request::body();

        $v = Validator::make($data, [
            'shortcut' => 'required|min:1|max:50',
            'title'    => 'required|min:1|max:100',
            'content'  => 'required|min:1',
        ]);
        if ($v->fails()) Response::error($v->firstError());

        $model = new CannedResponse();
        if ($model->shortcutTaken($data['shortcut'])) {
            Response::error('Ce raccourci est déjà utilisé', 409);
        }

        $id = $model->create(array_merge($data, ['created_by' => $user['sub']]));
        Response::json($model->findById($id), 201);
    }

    public function update(): void {
        Auth::requireRole('super_admin', 'admin');
        $id   = (int) Request::param('id');
        $data = Request::body();

        $model = new CannedResponse();
        if (!$model->findById($id)) Response::error('Template introuvable', 404);

        if (isset($data['shortcut']) && $model->shortcutTaken($data['shortcut'], $id)) {
            Response::error('Ce raccourci est déjà utilisé', 409);
        }

        $v = Validator::make($data, [
            'shortcut' => 'min:1|max:50',
            'title'    => 'min:1|max:100',
        ]);
        if ($v->fails()) Response::error($v->firstError());

        $model->update($id, $data);
        Response::json($model->findById($id));
    }

    public function delete(): void {
        Auth::requireRole('super_admin', 'admin');
        $id    = (int) Request::param('id');
        $model = new CannedResponse();
        if (!$model->findById($id)) Response::error('Template introuvable', 404);
        $model->delete($id);
        Response::json(['deleted' => true, 'id' => $id]);
    }
}
