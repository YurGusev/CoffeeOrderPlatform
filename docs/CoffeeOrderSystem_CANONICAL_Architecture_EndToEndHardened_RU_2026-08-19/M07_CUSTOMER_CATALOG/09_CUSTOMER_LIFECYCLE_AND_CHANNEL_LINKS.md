# M07. Customer lifecycle и связь с ChannelIdentity

## 1. Ownership

Customer bounded context владеет:

```text
Customer
CustomerContact
DeliveryAddressVersion
CustomerChannelLink
MergeHistory
CustomerAudit
```

Channel Platform владеет **техническим** `ChannelIdentityLedger` и не знает CustomerRef как provider identity fact.

## 2. Customer lifecycle

```text
Active
  ├─ Deactivated
  └─ Merged -> canonical CustomerRef
```

Hard delete normal-path запрещён. PII retention/purge — отдельный audited process.

### Active
Можно создавать Orders и linking.

### Deactivated
Новые Orders запрещены; история сохраняется.

### Merged
Старый CustomerRef становится redirect/alias на canonical CustomerRef. Existing Orders сохраняют исторический snapshot и original CustomerRef provenance.

## 3. CustomerChannelLink

```text
CustomerChannelLink
- linkRef
- customerRef
- channelIdentityRef
- identityEpochAtLink
- status: Active | RequiresRevalidation | Revoked
- verifiedAtUtc
- linkedBy
- linkReason
```

Инварианты:

- один `channelIdentityRef` имеет не более одной Active customer link;
- Customer может иметь несколько channel identities;
- raw VK/provider user IDs не хранятся в Customer DB;
- изменение `identityEpoch` не переносит link молча: link становится `RequiresRevalidation` до trusted proof/operator decision;
- relink требует audit reason и unique constraint transaction.

## 4. Delivery addresses

Адрес — versioned value, а не mutable string на Customer:

```text
DeliveryAddressVersion
addressRef
version
normalized fields
validFromUtc
retiredAtUtc?
```

Order хранит immutable address/customer snapshot выбранной версии.

## 5. Merge

Merge выполняется server command с expected versions обоих Customer records. Существующие Order/Invoice/Payment records не переписываются mass-update'ом; lookup projection знает canonical CustomerRef.

## 6. Events/cutover

В baseline нет отдельного Kafka Customer topic без реального cross-context consumer. Customer write transaction обязана публиковать `coffee.realtime.invalidate.v1` и audit; lifecycle Kafka topic добавляется только при появлении consumer, с отдельным ADR/schema.

C#→TS DB5 cutover требует:

- uniqueness CustomerChannelLink;
- merge/deactivate parity;
- PII access negative tests;
- exact ChannelIdentityRef resolution parity;
- no dual writer.
