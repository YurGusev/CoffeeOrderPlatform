# ADR-0031: nginx как публичный транспорт, Edge как прикладной авторизатор

- Статус: target-решение #159; становится принятым после merge в `develop`; **не admission runtime или production login**.
- Дата: 2026-09-24. Владелец: Platform Architecture.
- Вход: принятые #19/#4/#60/#61/#119/#137 и датированный
  source audit `develop@cd8cb2d8122622fd385b25944ebe9701f90f56e2`;
  актуальные contracts и handoffs перепроверены на
  `origin/develop@4962aee76617f42980631c6b7062259d84809dd3`.
- Нормативные детали: [29_NGINX_TRANSPORT_AND_AUTH.md](../launch/29_NGINX_TRANSPORT_AND_AUTH.md).
- Владелец 2026-09-24 подтвердил W1 OIDC/in-memory session и стартовые бюджеты
  именно как непроверенный target; уточнение `GET /auth/session` и actor-bound
  read-only recovery принято отдельно. Production login, мгновенная ревокация,
  5000 SSE и 5s end-to-end SLA этим согласием не подтверждены.

## Решение и граница supersession

Публичный HTTP(S)/SSE транспорт первого запуска передаётся отдельному **native** `edge-nginx`. Существующий Node/Fastify `edge-gateway` сохраняет имя и issuer `edge-gateway`, но становится только private authorizer: проверяет browser session/identity/permission, CSRF и подписывает actor context. `web` удаляется как runtime, но `apps/web` и browser build остаются; immutable SPA assets в nginx image. `api-public`, `api-internal`, owners, PostgreSQL, Kafka, AROMA Gateway, Outbox/Inbox и их service-to-service delegation не меняют ownership. nginx не получает actor signing key и не становится бизнес-оркестратором.

Это решение supersede-ит **только** распределение public TLS, статической раздачи, transport forwarding/SSE relay и public ingress identity между Node Edge и `web` в ADR-0019 и launch-документах. Не supersede-ит Fastify foundation ADR-0025 для приложений, их owner semantics, существующий compact Ed25519 actor assertion, `client-v1` contract или запреты canonical M19/M20. Прежние active `config/platform.yaml`, Compose и validators сохраняются до атомарного переключения #162. Поэтому до #162 reference topology по-прежнему описывает 15 Node runtime и 5 owner DB; после #162 целевая reference topology содержит 14 Node runtime + 1 native nginx, прежние 5 owner DB. Простое совпадение общего числа runtime не доказывает правильность состава.

## Trust и зависимые владельцы

Browser → `edge-nginx` public TLS; protected `client-v1`/`events` → private auth subrequest к `edge-gateway`; затем nginx с собственным mTLS service caller → `api-public`/`realtime-gateway`. Прикладной assertion подписывает только Edge: `iss=edge-gateway`, `originalIssuer=edge-gateway`, `aud=api-public|realtime-gateway`. `api-public` проверяет одновременно transport caller `edge-nginx`, подпись/claims, точную операцию и permissions, а owner-hop оставляет прежним `iss=api-public`, `originalIssuer=edge-gateway`. `api-internal`, `agent-v1` и provider ingress не становятся browser routes. W1 не резервирует VK/PSP endpoints.

Публичная пара TLS переносится только nginx; отдельные service identities остаются у nginx и авторизатора. Для nginx upstream TLS проверяются CA + exact runtime/environment DNS SAN при сохранении URI SAN для Node↔Node. `config-bootstrap` создаёт scoped PEM в tmpfs; новый файл конфигурации или shared secrets store не появляется. Значения — только `config/platform.yaml`, encrypted secrets — только `secrets/platform.secrets.sops.yaml`, version/digest — только `config/toolchain-versions.json`. Derived nginx config — детерминированный artifact, не третий источник.

## Причина, альтернативы и последствия

Node reverse proxy + отдельный Node web заставляют два runtime отвечать за публичный транспорт и не дают одного согласованного профиля TLS/static/SSE. Встраивать auth/бизнес-правила в nginx (njs/Lua) или доверять только mTLS вместо подписанного actor proof запрещено. Redis/session DB, service mesh и второй transport path не вводятся без необходимости. `GET /auth/session` возвращает лишь actorRef/expiry без продления login: 401/session expiry замораживает pending intent, не определяет исход команды; после reauth прежнего actor разрешена только явная read-only проверка результата по [recovery contract](../launch/26_BROWSER_COMMAND_RECOVERY.md), а не новая mutation.

Новая граница измерения: nginx connect/read/send **inactivity** limits не заменяют прежний суммарный 5s Node Edge timer. Authorizer и `api-public` имеют отдельные absolute deadlines; frontend получает измеряемый end-to-end SLA, а не ложное обещание старого wall-clock budget. SSE не ограничивается 5s, его replay/backpressure/permission и single instance принадлежат #12. Целевые capacity budgets в launch contract — admission targets, не результат замера.

Поставка: #160 реализует application auth/receiver; #161 собирает native image/config/isolated transport tests; #162 после обоих выполняет **один** active cutover с удалением старого пути и coherent rollback bundle. #9 принимает browser/deep-link flow, #12 — realtime auth/soak, #64 — native observability, #13 — launch verification. Эти downstream issues не prerequisites решения и не блокируют #162: последний тестирует upstream fixtures. W2 #76/#77 и W3 #97/#98/#99 задают будущие topology, exact callback contracts и admission; публичный `agent-v1` ими не становится. Этот ADR будущий provider ingress не разрешает. До реального IdP profile/claims/keys production login блокирован, никакой документ не доказывает browser, TLS, capacity, HA или deployment.
