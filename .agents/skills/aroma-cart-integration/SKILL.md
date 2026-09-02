---
name: aroma-cart-integration
description: Реализовывать или проверять AROMA Gateway, безопасные чтения каталога/корзины, Orders-owned Desired/Observed convergence, fencing, UnknownOutcome и восстановление провайдера.
---

# Интеграция с корзиной AROMA

Прочитать `docs/launch/04_AROMA_CART_SAFETY.md` и канонические M11/M12/M20.
Gateway владеет credentials/session/typed HTTP; Orders — intent, attempts и recovery.

`mutationCapability` — immutable capability конкретного runtime, а
`services.aroma-convergence.mutationsEnabled` — mutable operational switch.
Мутация разрешена только когда оба значения `true`; при `false` runtime остаётся
read/recovery-only. Переключатель не отменяет fencing, reconciliation и audit.

Unsafe operation: acquire lease/fence; verify Desired and Catalog proof;
reserve one operation; fresh GET; at most one mutation; fresh GET; persist only
with current fence.

Никогда не повторять мутацию вслепую. Timeout после возможной мутации означает
`UnknownOutcome`; следующей мутации предшествует reconciliation со свежим GET.
Старый `operationRef` нельзя использовать для повторной отправки мутации.
Failed GET не очищает Observed. Kafka — сигнал пробуждения/версии, а не
доказательство. Browser, Hermes, Catalog и edge не мутируют корзину.

Проверять потерю ответа, stale fence, lease expiry, restart с reservation,
partial/failed GET, mapping state, rate/circuit, redaction и authorization.
