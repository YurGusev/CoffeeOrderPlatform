# M20. Service Graph Acceptance Checklist

Перед merge любого cross-service изменения:

- [ ] Назван business owner каждого изменяемого факта.
- [ ] Runtime role не объявлен новым owner только из-за отдельного Deployment.
- [ ] Нет direct cross-owner DB read/write для mutation logic.
- [ ] Нет sync HTTP business cycle.
- [ ] Confirm transaction не вызывает Catalog/AROMA/Invoices/Payments.
- [ ] Kafka command/event owner и key добавлены в M06 registry.
- [ ] Consumer имеет Inbox/idempotency/current-state check.
- [ ] Provider mutation выполняется только через owning business state machine + Gateway primitive.
- [ ] AROMA unsafe path сохраняет GET -> one mutation -> GET и UnknownOutcome.
- [ ] Invoice creation имеет checkout/wholesale proof, а не только OrderConfirmed.
- [ ] Payment success является verified Payments fact.
- [ ] React/Hermes/n8n не получили direct provider mutation API.
- [ ] NetworkPolicy/Kafka ACL/DB credential соответствуют policy.
- [ ] `service-interaction-policy.yml` обновлён, если edge действительно новый.

- [ ] Catalog supplier sync имеет только safe complete-catalog GET и не имеет cart mutation capability.
- [ ] Orders Draft/Catalog sync read не попал в Confirm transaction.
- [ ] Orders Convergence/Catalog preflight читает persisted complete snapshot proof и не запускает per-item provider lookup.
- [ ] Catalog price-only change не приводит к Desired/cart mutation.
- [ ] Mapping/availability/tombstone change доставляется через Outbox/Kafka и current-state guarded Orders consumer.
