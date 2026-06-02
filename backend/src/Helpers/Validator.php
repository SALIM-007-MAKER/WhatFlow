<?php
namespace Helpers;

class Validator {
    private array $errors = [];
    private array $data;

    public function __construct(array $data) {
        $this->data = $data;
    }

    public static function make(array $data, array $rules): self {
        $v = new self($data);
        foreach ($rules as $field => $rule_string) {
            $rules_list = explode('|', $rule_string);
            foreach ($rules_list as $rule) {
                $v->applyRule($field, $rule);
            }
        }
        return $v;
    }

    private function applyRule(string $field, string $rule): void {
        $value = $this->data[$field] ?? null;

        if ($rule === 'required') {
            if ($value === null || $value === '') {
                $this->errors[$field][] = "$field est requis";
            }
            return;
        }

        if ($value === null || $value === '') return;

        if ($rule === 'email' && !filter_var($value, FILTER_VALIDATE_EMAIL)) {
            $this->errors[$field][] = "$field doit être un email valide";
        }

        if (str_starts_with($rule, 'min:')) {
            $min = (int) substr($rule, 4);
            if (strlen((string)$value) < $min) {
                $this->errors[$field][] = "$field doit contenir au moins $min caractères";
            }
        }

        if (str_starts_with($rule, 'max:')) {
            $max = (int) substr($rule, 4);
            if (strlen((string)$value) > $max) {
                $this->errors[$field][] = "$field ne doit pas dépasser $max caractères";
            }
        }

        if (str_starts_with($rule, 'in:')) {
            $allowed = explode(',', substr($rule, 3));
            if (!in_array($value, $allowed)) {
                $this->errors[$field][] = "$field doit être l'une des valeurs: " . implode(', ', $allowed);
            }
        }
    }

    public function fails(): bool {
        return !empty($this->errors);
    }

    public function errors(): array {
        return $this->errors;
    }

    public function firstError(): string {
        foreach ($this->errors as $msgs) {
            return $msgs[0];
        }
        return 'Validation échouée';
    }
}
