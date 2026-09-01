# Service identity, actor и delegation

Статус: нормативный security contract #19/#3/#4.

## Transport identity

Внутренняя CA создаётся только provisioning role; CA private key никогда не
попадает в runtime. Для каждого HTTP runtime выдаётся отдельный Ed25519 service
certificate с SPIFFE-like SAN `spiffe://coffee-platform/<environment>/<runtime>`.
Certificate TTL — 24h, rotation начинается за 6h, overlap active/previous trust
bundle — 12h. Runtime получает только свой key/cert в scoped tmpfs; public trust
bundle находится в `platform.yaml`. Expired/unknown SAN делает readiness 503.
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

## Internal service delegation

Caller устанавливает mTLS к `api-internal`. Root проверяет SAN+operation matrix
и выпускает assertion `iss=api-internal`, `aud=<target>`, `originalCaller`,
`operationId`, correlation/trace/iat/exp/jti/kid. Target требует transport SAN
`api-internal` и все claims. Gateway mutation разрешена только при
`originalCaller=aroma-convergence` и exact set/remove operation.

Negative tests: forged actor/originalCaller, wrong SAN/audience/operation,
expired/revoked certificate, key rotation overlap, api-public internal route,
api-internal client route и mutation от observer/catalog sync.
