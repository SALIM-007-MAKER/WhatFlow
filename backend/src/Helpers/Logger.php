<?php
namespace Helpers;

class Logger {
    public static function log(string $level, string $message, array $context = []): void {
        $timestamp = date('Y-m-d H:i:s');
        $ctx       = $context ? ' ' . json_encode($context) : '';
        $line      = "[$timestamp] [$level] $message$ctx" . PHP_EOL;
        $file      = LOG_PATH . 'app.log';
        @file_put_contents($file, $line, FILE_APPEND | LOCK_EX);
    }

    public static function info(string $msg, array $ctx = []): void  { self::log('INFO',  $msg, $ctx); }
    public static function error(string $msg, array $ctx = []): void { self::log('ERROR', $msg, $ctx); }
    public static function warn(string $msg, array $ctx = []): void  { self::log('WARN',  $msg, $ctx); }
    public static function debug(string $msg, array $ctx = []): void {
        if (APP_ENV === 'development') self::log('DEBUG', $msg, $ctx);
    }
}
