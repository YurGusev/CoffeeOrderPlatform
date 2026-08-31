# Repository Security and Sanitation

## Нормативный gate до начала clean-room migration

1. Любой credential, когда-либо попавший в Git, считается скомпрометированным.
2. Сначала выполняется provider-side revoke/rotation и audit log review.
3. Затем файл удаляется из current tree.
4. Затем выполняется controlled history rewrite (`git filter-repo`/эквивалент) с maintenance window.
5. После rewrite обязательны fresh clones и full-history secret scan.

## Запрещённые tracked artifacts

```text
.env.agent
.env.* с реальными secret values
**/venv*/
**/.venv/
**/site-packages/
node_modules/
bin/
obj/
raw model weights
runtime logs/caches
```

## Bootstrap administrator

Hard-coded password в source/config запрещён. Production bootstrap:

```text
one-time bootstrap-admin Job/CLI
→ secret manager / one-time injected secret
→ create admin
→ require credential rotation
→ revoke/delete bootstrap secret
```

Job идемпотентен, но после успешного bootstrap должен быть disabled.

## Refresh/session

Для browser baseline используется server-side opaque session с idle + absolute expiry и antiforgery. Stateless browser refresh token не является baseline. Если позже нужен refresh family, обязательны hashed token, family id, rotation, reuse detection, absolute expiry и revoke-family.

## CI gates

- secret scan current tree + full history before history-cutover;
- large-file threshold;
- forbidden dependency-tree scan;
- no secret-like literal in docs/tests except synthetic allowlisted fixtures;
- `git diff --check`;
- generated artifact paths excluded.
