# ADR-0021: GitHub — единственная operational authority

Статус: Accepted. Дата: 2026-09-01.

Для `YurGusev/CoffeeOrderPlatform` единственным remote forge является GitHub.
GitHub владеет issues, labels, branches, pull requests, reviews, checks,
releases и Projects. Другие forge, зеркала и параллельная нумерация задач не являются
delivery authority и не получают автоматические записи.

Перед любой remote mutation automation обязана доказать:

```text
git remote get-url origin == https://github.com/YurGusev/CoffeeOrderPlatform.git
gh repo view --json nameWithOwner == YurGusev/CoffeeOrderPlatform
gh auth status == authenticated
```

Read-only GitHub discovery разрешён. Push, issue/PR/Project/release mutation
требует явной scoped команды пользователя или заранее выданного разрешения
конкретного workflow. Verification runner всегда создаёт локальный sanitized
defect artifact; GitHub issue публикует отдельный permission-gated step. Отказ
публикации не скрывает FAIL и не меняет решение `НЕ ДОПУСТИТЬ`.

Рабочая линия: ветка задачи от `develop`, один issue — одна ветка — один PR в
`develop`, русский текст, GitHub checks/review, затем merge. `main` получает
только принятые release changes. Любая ссылка на не-GitHub forge в изменяемых
документах/skills/checkers блокирует `pnpm authority:check`.
