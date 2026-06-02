<?php
namespace Core;

class Router {
    private array $routes = [];

    public function get(string $path, callable|array $handler): void {
        $this->addRoute('GET', $path, $handler);
    }

    public function post(string $path, callable|array $handler): void {
        $this->addRoute('POST', $path, $handler);
    }

    public function put(string $path, callable|array $handler): void {
        $this->addRoute('PUT', $path, $handler);
    }

    public function delete(string $path, callable|array $handler): void {
        $this->addRoute('DELETE', $path, $handler);
    }

    private function addRoute(string $method, string $path, callable|array $handler): void {
        $this->routes[] = ['method' => $method, 'path' => $path, 'handler' => $handler];
    }

    public function dispatch(): void {
        $method = $_SERVER['REQUEST_METHOD'];
        $uri    = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

        // Strip the script directory prefix so routes work under any sub-path (Apache) or at root (php -S)
        $base = rtrim(dirname($_SERVER['SCRIPT_NAME'] ?? ''), '/\\');
        if ($base && $base !== '/' && str_starts_with($uri, $base)) {
            $uri = substr($uri, strlen($base));
        }
        if ($uri === '' || $uri === false) $uri = '/';

        foreach ($this->routes as $route) {
            if ($route['method'] !== $method) continue;

            $params = $this->match($route['path'], $uri);
            if ($params === null) continue;

            Request::setParams($params);

            $handler = $route['handler'];
            if (is_callable($handler)) {
                $handler();
            } else {
                [$class, $method_name] = $handler;
                (new $class())->$method_name();
            }
            return;
        }

        Response::error('Route non trouvée', 404);
    }

    private function match(string $routePath, string $uri): ?array {
        $pattern = preg_replace('/:([a-z_]+)/', '(?P<$1>[^/]+)', $routePath);
        $pattern = '#^' . $pattern . '$#';

        if (!preg_match($pattern, $uri, $matches)) return null;

        $params = [];
        foreach ($matches as $key => $value) {
            if (is_string($key)) $params[$key] = $value;
        }
        return $params;
    }
}
