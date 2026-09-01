# Live proof PostgreSQL для issue #3

Proof запускается только на отдельном disposable Docker-контейнере с образом
`postgres:17.11-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73`.
Контейнер получает случайное имя/порт и удаляется через `docker rm --force` в
`finally`. Существующий `coffee_postgres` не используется.

```text
pnpm db:live-proof -- --run-id issue3proof --evidence-dir evidence/database/results
```

Проверка создаёт внутри одноразового контейнера две sentinel-БД с именами
legacy, сохраняет их строки до/после и проверяет отсутствие изменений. Затем
дважды вызывает `db-bootstrap`: первый запуск обязан создать пять БД, второй —
увидеть пять существующих БД и не менять владельцев. Для всех 15 ролей
проверяются hardened attributes; каждая app-role выполняет временную запись в
своей БД с `ROLLBACK`, а 10 app-role выполняют по 40 cross-owner `SELECT` и
`INSERT`, которые должны завершиться PostgreSQL `42501 permission denied`.

JSON evidence не содержит URL, пароль или plaintext secret. Его схема —
`issue-3-live-proof.schema.json`; каталог `results` является runtime output и
не должен коммититься.
