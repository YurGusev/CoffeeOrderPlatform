# Identity/session/bootstrap security

## Browser

Baseline: server-side opaque session ticket, HttpOnly/Secure/SameSite cookie, antiforgery on mutations, idle + absolute expiry, security-stamp/user-status invalidation, fail-closed store errors.

## Service identities

Short-lived service credential/mTLS/JWT with audience and scope; browser token model не переиспользуется.

## Bootstrap

No hard-coded admin password. One-time bootstrap Job reads secret from approved secret store, creates admin, requires rotation, then disables bootstrap path.

## Refresh token

Browser refresh token отсутствует в baseline. Если вводится позже — только persisted hash/family/rotation/reuse-detection/revoke model. Endpoint, который принимает произвольный сгенерированный, но не проверяемый refresh token, запрещён.
