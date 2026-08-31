# M07. Product deletion и production purge

## Normal deletion

Product/Variant deletion normal path = **soft tombstone**, expected version + audit + Outbox. It immediately becomes non-orderable and Orders receives tombstone/mapping Removed facts.

## DeleteAll

Public/browser `delete-all` production operation **удаляется из canonical client-v1**.

Полный purge допускается только offline maintenance job:

1. maintenance mode;
2. recent verified DB + artifact backup;
3. preflight: no active Draft/Confirmed Orders referencing target identities unless explicit migration plan;
4. no CheckoutPending/Wholesale compensation in progress;
5. bounded batches;
6. Kafka/Orders/Aroma convergence backlog budget;
7. audit/incident approval;
8. restore/rollback plan.

Hard physical deletion выполняется только после retention window и доказанного отсутствия business references.
