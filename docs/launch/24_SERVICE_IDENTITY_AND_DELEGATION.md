# Service identity, actor и delegation

**Reference baseline #162:** [ADR-0031](../adr/ADR-0031-nginx-transport-and-application-auth.md)
и [contract #159](29_NGINX_TRANSPORT_AND_AUTH.md) задают
`edge-nginx` как отдельный mTLS caller и держатель public TLS key, private
`edge-gateway` как единственный `iss=edge-gateway`/actor signer. nginx→Edge
auth request и nginx→api-public/realtime используют scoped transport identity
с URI SAN + exact runtime/environment DNS SAN у nginx targets; receiver
требует SAN `edge-nginx` и подписанный issuer/audience/operation одновременно.
Edge→api-public direct transport запрещён; api-public→owner-hop и все internal
delegation ниже остаются прежними. Rotation/failure negatives и distinct scopes
закреплены contract #159. Reference wiring не доказывает реальные production
IdP credentials/сертификаты и не заменяет admission #13.

Статус: нормативный security contract #19/#3/#4.

## Transport identity

Внутренняя CA создаётся только provisioning role; CA private key никогда не
попадает в runtime. Для каждого HTTP runtime выдаётся отдельный Ed25519 service
certificate с SPIFFE-like SAN `spiffe://coffee-platform/<environment>/<runtime>`.
Certificate TTL — 24h, rotation начинается за 6h, overlap active/previous trust
bundle — 12h. Runtime получает только свой key/cert в scoped tmpfs; public trust
bundle находится в `platform.yaml`. `edge-nginx` использует public TLS listener
без требования client certificate от браузера: его `edge.tlsPrivateKey` и
`edge.tlsCertificate` — отдельная серверная пара с hostname из
`platform.publicBaseUrl`. Для upstream nginx использует **свою** mTLS identity,
не public pair и не actor signing key. `edge-gateway` получает только свой
private listener mTLS identity, OIDC secret и actor signing key. Остальные runtime используют
mTLS listener и client. Expired/unknown SAN делает readiness 503 на internal
trust surface.
Для первого Compose launch rotation/revocation применяется повторным
config-bootstrap и restart всех затронутых runtime; отдельная PKI-служба не нужна.

## Public actor delegation

1. Edge аутентифицирует user и подписывает assertion `iss=edge-gateway`,
   `aud=api-public`, `sub=actorRef`, permissions, operationId, correlationId,
   `iat/exp/jti/kid`; TTL ≤60s.
2. `api-public` проверяет assertion и route, использует отдельный delegation
   signing key (не transport private key), устанавливает mTLS к exact owner и
   подписывает delegated assertion `iss=api-public`, `aud=<owner-runtime>`,
   `originalIssuer=edge-gateway`, actor/permissions/operation/correlation/trace,
   TTL ≤ remaining request deadline +5s skew.
3. Owner требует одновременно SAN caller=`api-public`, correct issuer/audience,
   allowlisted operation и permission. Client headers удаляются Edge.

#160 материализует isolated authorizer и receiver: `GET /_edge/authorize` принимает
только transport identity `edge-nginx`, выводит операцию и право из `client-v1`
и выпускает текущий compact Ed25519 actor assertion с отдельным scoped signing
key и expiry ≤60s/конец session. nginx не подписывает assertion, а передаёт
полученный `X-Actor-Context` и тот же `X-Correlation-ID`; `api-public` проверяет
transport caller, issuer, audience, operation, correlation, permission и TTL до
owner delegation. В reference-профиле #162 receiver ожидает `edge-nginx`
caller: один заголовок без verified transport peer не даёт доступ. Для SSE
назначение assertion — `realtime-gateway`, а его receiver/reauth — задача #12.
Fixture tests и ограничения передаются через `evidence/handoffs/issue-160.yaml`;
production trust и IdP не подтверждены наличием reference-конфигурации.

## Internal service delegation

### Orders-service: ключи и delegation #8

Утверждено владельцем 27 сентября 2026; подлежит материализации в #8:

- `security.ordersServiceDelegationSigningPrivateKey` — отдельный Ed25519
  private key только `orders-service` для исходящих calls в `api-internal`.
  Он не совпадает с mTLS key и не заимствуется у Edge/api-public/Pricing.
- Caller assertion: `iss=orders-service`, `aud=api-internal`,
  `originalCaller=orders-service`, точный `operationId`, correlation/trace,
  `iat/exp/jti/kid`. Разрешены только `getCustomerOrderInput` и
  `verifyPricingQuote`; TTL ограничен оставшимся deadline + существующий 5s skew.
- `api-internal` одновременно проверяет mTLS SAN Orders, claims и операцию
  через `security.serviceVerificationKeys.orders-service` (active/previous),
  затем выпускает собственную delegation к exact owner. Orders private key
  не передаётся `api-internal` или целевому owner.
- Входящий actor context Orders проверяет публичными
  `security.delegationVerificationKeys.api-public` (active/previous):
  mTLS caller/issuer=`api-public`, audience=`orders-service`,
  originalIssuer=`edge-gateway`, actor/operation/correlation/trace/TTL и permission
  из [карты Orders](17_ORDERS_IMPLEMENTATION_SPEC.md#права-browser-операций).
- Собственные `security.serviceTransportKeys.orders-service` остаются отдельным
  transport scope. Новый private key хранится только в encrypted
  `secrets/platform.secrets.sops.yaml`; trusted config-bootstrap выдаёт его
  только Orders в scoped tmpfs. Ни общий decrypted файл, ни private keys
  соседних runtime Orders не получает.

В реализации обновить secret schema, exact secretRefs/config checks,
bootstrap/provisioning и тесты по существующему Pricing pattern. Отсутствие
нужного signing/verification material закрывается ошибкой конфигурации, без
фиктивных ключей, shared fallback или запуска небезопасного handler.
Проверить active/previous rotation, missing/wrong key, wrong SAN/issuer/audience/
operation/originalCaller, истёкший assertion и запрет выдачи чужого private key.
Запись этого решения не означает наличия production material и не разрешает
публиковать секреты или менять production.

### Общая цепочка и матрица операций

Caller устанавливает mTLS к `api-internal`. Root проверяет SAN+operation matrix
и выпускает assertion `iss=api-internal`, `aud=<target>`, `originalCaller`,
`operationId`, correlation/trace/iat/exp/jti/kid. Target требует transport SAN
`api-internal` и все claims. Gateway mutation разрешена только при
`originalCaller=aroma-convergence` и exact set/remove operation.

Machine authority #19 фиксирует следующие `operationId`; #4 переносит их в
`internal-v1.yaml` без повторного выбора:

| Original caller | Target | Method и path | `operationId` | Mutation |
|---|---|---|---|---|
| `orders-service` | `customer-service` | `GET /api/internal-v1/customers/{customerRef}/order-input` | `getCustomerOrderInput` | нет |
| `pricing-service` | `catalog-service` | `GET /api/internal-v1/catalog/products/{productRef}/variants/{variantRef}/pricing-input` | `getCatalogPricingInput` | нет |
| `orders-service` | `pricing-service` | `POST /api/internal-v1/pricing/quotes:verify` | `verifyPricingQuote` | нет |
| `catalog-supplier-sync` | `aroma-gateway` | `POST /api/internal-v1/aroma/catalog-exports` | `exportAromaCatalog` | нет |
| `catalog-activation-worker` | `aroma-gateway` | `POST /api/internal-v1/aroma/offer-bindings` | `registerAromaOfferBinding` | нет |
| `aroma-observer` | `aroma-gateway` | `POST /api/internal-v1/aroma/cart-snapshots:read` | `readAromaCartSnapshot` | нет |
| `aroma-convergence` | `aroma-gateway` | `POST /api/internal-v1/aroma/cart-snapshots:read` | `readAromaCartSnapshot` | нет |
| `aroma-convergence` | `aroma-gateway` | `POST /api/internal-v1/aroma/cart-lines/{offerRef}:set-quantity` | `setAromaCartLineQuantity` | да |
| `aroma-convergence` | `aroma-gateway` | `POST /api/internal-v1/aroma/cart-lines/{offerRef}:remove` | `removeAromaCartLine` | да |

Allowlist является точным множеством. Совпадение только path, caller или
transport SAN не предоставляет capability: target одновременно проверяет
transport caller, issuer, audience, original caller и `operationId`.

Negative tests: forged actor/originalCaller, wrong SAN/audience/operation,
expired/revoked certificate, key rotation overlap, api-public internal route,
api-internal client route и mutation от observer/catalog sync.
