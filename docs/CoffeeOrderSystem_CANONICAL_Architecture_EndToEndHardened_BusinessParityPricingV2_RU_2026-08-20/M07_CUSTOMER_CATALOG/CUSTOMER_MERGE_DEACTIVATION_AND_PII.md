# Customer merge, deactivation and PII

## PII fields

Имя, телефон, email, адрес доставки, channel identity и свободные notes классифицируются как PII. Kafka события должны нести только минимально необходимый snapshot/ref.

## Deactivate

Deactivation запрещает использование Customer для новых Orders/Channel links, но не ломает исторические Orders/Invoices.

## Anonymize

Anonymization применяется только после policy check. Она заменяет прямые PII значениями/токенами, сохраняющими referential integrity и финансовый audit. Финансовые/налоговые документы не удаляются в нарушение retention obligations.

## Delivery conditions / price group

Customer может иметь:

```text
CustomerDeliveryProfile
CustomerPriceGroupRef (optional)
```

Эти данные versioned. Order хранит snapshot условий, применённых при Confirm, чтобы последующее изменение Customer не переписывало историю.

## Channel identity

Channel identity link не является Customer master record. Link может быть revoked/relinked без удаления Customer.
