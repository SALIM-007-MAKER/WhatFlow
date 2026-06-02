<?php

// Load .env from project root
$_envFile = __DIR__ . '/../../.env';
if (file_exists($_envFile)) {
    foreach (file($_envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $_line) {
        if (str_starts_with(trim($_line), '#') || !str_contains($_line, '=')) continue;
        [$_k, $_v] = explode('=', $_line, 2);
        $_ENV[trim($_k)] = trim($_v);
    }
}
unset($_envFile, $_line, $_k, $_v);

define('APP_ENV',              'development');
define('APP_URL',              'http://localhost/WhatFlow/backend/public');
define('FRONTEND_URL',         'http://localhost');

define('DB_HOST',              '127.0.0.1');
define('DB_PORT',              '3306');
define('DB_NAME',              'code2mode');
define('DB_USER',              'root');
define('DB_PASS',              '');
define('DB_CHARSET',           'utf8mb4');

define('JWT_SECRET',           $_ENV['JWT_SECRET']            ?? 'dev-secret-key-minimum-32-characters!!');
define('JWT_EXPIRES',          86400);

define('GEMINI_API_KEY',       $_ENV['GEMINI_API_KEY']        ?? '');
define('AI_MODEL',             'gemini-2.5-flash');
define('AI_MAX_TOKENS',        1000);

define('WHATSAPP_BRIDGE_URL',  'http://localhost:3001');
define('WHATSAPP_BRIDGE_SECRET', $_ENV['BRIDGE_SECRET']       ?? 'bridge-internal-secret');

define('LOG_PATH',             __DIR__ . '/../logs/');
define('UPLOAD_PATH',          __DIR__ . '/../uploads/');
