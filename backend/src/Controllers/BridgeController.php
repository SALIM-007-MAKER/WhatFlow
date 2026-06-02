<?php
namespace Controllers;
use Core\{Auth, Response, Request};
use Services\WhatsAppBridge;

class BridgeController {

    private const BRIDGE_PORT = 3001;

    private string $pidFile;
    private string $logFile;
    private string $bridgePath;
    private string $bridgeDir;

    public function __construct() {
        $base             = dirname(__DIR__, 2) . DIRECTORY_SEPARATOR . 'storage';
        $this->pidFile    = $base . DIRECTORY_SEPARATOR . 'bridge.pid';
        $this->logFile    = $base . DIRECTORY_SEPARATOR . 'logs' . DIRECTORY_SEPARATOR . 'bridge.log';
        $this->bridgeDir  = dirname(__DIR__, 3) . DIRECTORY_SEPARATOR . 'whatsapp-bridge';
        $this->bridgePath = $this->bridgeDir . DIRECTORY_SEPARATOR . 'bridge.js';
    }

    // ── GET /api/bridge/status ────────────────────────────────────────────
    public function status(): void {
        Auth::require();

        $pid = $this->getEffectivePid();

        $running = $pid !== null;
        if (!$running) $this->clearPid();

        $wa = [];
        if ($running) {
            try { $wa = (new WhatsAppBridge())->getStatus(); } catch (\Throwable) {}
        }

        Response::json([
            'running'   => $running,
            'pid'       => $pid,
            'connected' => $wa['connected'] ?? false,
            'phone'     => $wa['phone'] ?? null,
        ]);
    }

    // ── POST /api/bridge/start ────────────────────────────────────────────
    public function start(): void {
        Auth::requireRole('admin', 'super_admin');

        // Check for orphaned process holding the port
        $orphanPid = $this->findPidByPort(self::BRIDGE_PORT);
        if ($orphanPid) {
            // Kill the orphan so we can start fresh
            $this->killProcess($orphanPid);
            $this->clearPid();
            usleep(800_000);
        }

        if ($this->isRunning()) {
            Response::error('Le bridge est déjà en cours d\'exécution', 409);
        }

        $this->ensureDirs();
        $this->launchProcess();

        // Give the process 500ms to write its PID — frontend polls status via _pollBridgeUntilRunning
        usleep(500_000);
        $pid     = $this->getPid();
        $running = $pid && $this->isProcessRunning($pid);
        if (!$running) {
            $portPid = $this->findPidByPort(self::BRIDGE_PORT);
            if ($portPid) { $pid = $portPid; $running = true; }
        }

        Response::json(['started' => $running, 'pid' => $pid]);
    }

    // ── POST /api/bridge/stop ─────────────────────────────────────────────
    public function stop(): void {
        Auth::requireRole('admin', 'super_admin');

        $pid = $this->getEffectivePid();
        if (!$pid) {
            Response::error('Le bridge n\'est pas en cours d\'exécution', 409);
        }

        $this->killProcess($pid);
        $this->clearPid();

        Response::json(['stopped' => true, 'pid' => $pid]);
    }

    // ── POST /api/bridge/restart ──────────────────────────────────────────
    public function restart(): void {
        Auth::requireRole('admin', 'super_admin');

        $pid = $this->getEffectivePid();
        if ($pid) {
            $this->killProcess($pid);
            $this->clearPid();
            usleep(800_000);
        }

        $this->ensureDirs();
        $this->launchProcess();

        sleep(2);
        $newPid  = $this->getPid();
        $running = $newPid && $this->isProcessRunning($newPid);
        if (!$running) {
            $portPid = $this->findPidByPort(self::BRIDGE_PORT);
            if ($portPid) { $newPid = $portPid; $running = true; }
        }

        Response::json(['restarted' => $running, 'pid' => $newPid]);
    }

    // ── GET /api/bridge/logs ──────────────────────────────────────────────
    public function logs(): void {
        Auth::requireRole('admin', 'super_admin');

        $lines = min(500, max(10, (int) Request::get('lines', 200)));

        if (!file_exists($this->logFile)) {
            Response::json(['lines' => [], 'size' => 0, 'total' => 0]);
            return;
        }

        $all  = file($this->logFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];
        $last = array_values(array_slice($all, -$lines));

        Response::json([
            'lines' => $last,
            'size'  => filesize($this->logFile),
            'total' => count($all),
        ]);
    }

    // ── DELETE /api/bridge/logs ───────────────────────────────────────────
    public function clearLogs(): void {
        Auth::requireRole('super_admin');

        if (file_exists($this->logFile)) {
            file_put_contents($this->logFile, '');
        }

        Response::json(['cleared' => true]);
    }

    // ── Helpers privés ────────────────────────────────────────────────────

    private function launchProcess(): void {
        $node = $this->findNode();
        $js   = $this->bridgePath;
        $dir  = $this->bridgeDir;

        if (PHP_OS_FAMILY === 'Windows') {
            // WScript.Shell.Run() creates a fully detached process — no handle inheritance
            $cmd = sprintf('"%s" "%s"', $node, $js);
            try {
                $wsh = new \COM('WScript.Shell');
                $wsh->Run($cmd, 0, false); // 0=hidden, false=don't wait
            } catch (\Throwable $e) {
                // Fallback: batch file with NUL redirections
                $bat = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'wf_bridge_start.bat';
                file_put_contents($bat,
                    "@echo off\r\n" .
                    "cd /d \"{$dir}\"\r\n" .
                    "start \"WhatFlow Bridge\" /B \"{$node}\" \"{$js}\" <NUL >NUL 2>&1\r\n"
                );
                pclose(popen("cmd /C \"{$bat}\"", 'r'));
                @unlink($bat);
            }
        } else {
            $cmd = sprintf('cd "%s" && "%s" "%s" > /dev/null 2>&1 &', $dir, $node, $js);
            pclose(popen($cmd, 'r'));
        }
    }

    private function killProcess(int $pid): void {
        // Try graceful shutdown first (lets bridge call client.destroy())
        $this->gracefulShutdown();

        // Wait up to 4s for process to exit on its own
        for ($i = 0; $i < 8; $i++) {
            usleep(500_000);
            if (!$this->isProcessRunning($pid)) return;
        }

        // Force kill if still alive
        if (PHP_OS_FAMILY === 'Windows') {
            exec("taskkill /F /PID $pid 2>NUL");
        } else {
            exec("kill -KILL $pid 2>/dev/null");
        }
    }

    private function gracefulShutdown(): void {
        $secret = defined('BRIDGE_SECRET') ? BRIDGE_SECRET : 'bridge-internal-secret';
        $secret = $_ENV['BRIDGE_SECRET'] ?? getenv('BRIDGE_SECRET') ?: 'bridge-internal-secret';
        try {
            $ctx = stream_context_create(['http' => [
                'method'  => 'POST',
                'header'  => "x-bridge-secret: {$secret}\r\nContent-Length: 0\r\n",
                'timeout' => 2,
                'ignore_errors' => true,
            ]]);
            @file_get_contents('http://localhost:3001/shutdown', false, $ctx);
        } catch (\Throwable) {}
    }

    private function isProcessRunning(int $pid): bool {
        if (PHP_OS_FAMILY === 'Windows') {
            exec("tasklist /FI \"PID eq $pid\" /FO CSV /NH 2>NUL", $out);
            foreach ($out as $line) {
                if (str_contains($line, (string) $pid)) return true;
            }
            return false;
        }
        return file_exists("/proc/$pid");
    }

    /** Returns PID from file if process is alive, otherwise checks port for orphan. */
    private function getEffectivePid(): ?int {
        $pid = $this->getPid();
        if ($pid && $this->isProcessRunning($pid)) return $pid;
        if ($pid) $this->clearPid();

        // Fallback: detect orphan holding port 3001
        $portPid = $this->findPidByPort(self::BRIDGE_PORT);
        if ($portPid && $this->isProcessRunning($portPid)) return $portPid;

        return null;
    }

    /** Find PID of the process listening on a given port (Windows only). */
    private function findPidByPort(int $port): ?int {
        if (PHP_OS_FAMILY !== 'Windows') return null;
        exec("netstat -ano 2>NUL", $lines);
        foreach ($lines as $line) {
            if (str_contains($line, ':' . $port) && str_contains($line, 'LISTENING')) {
                $parts = preg_split('/\s+/', trim($line));
                $last  = end($parts);
                if (is_numeric($last) && (int) $last > 0) return (int) $last;
            }
        }
        return null;
    }

    private function isRunning(): bool {
        return $this->getEffectivePid() !== null;
    }

    private function getPid(): ?int {
        if (!file_exists($this->pidFile)) return null;
        $raw = trim((string) file_get_contents($this->pidFile));
        return is_numeric($raw) ? (int) $raw : null;
    }

    private function clearPid(): void {
        if (file_exists($this->pidFile)) @unlink($this->pidFile);
    }

    private function ensureDirs(): void {
        $dirs = [dirname($this->pidFile), dirname($this->logFile)];
        foreach ($dirs as $dir) {
            if (!is_dir($dir)) mkdir($dir, 0775, true);
        }
    }

    private function findNode(): string {
        if (PHP_OS_FAMILY === 'Windows') {
            exec('where node 2>NUL', $out);
            return trim($out[0] ?? 'node');
        }
        exec('which node 2>/dev/null', $out);
        return trim($out[0] ?? '/usr/bin/node');
    }
}
