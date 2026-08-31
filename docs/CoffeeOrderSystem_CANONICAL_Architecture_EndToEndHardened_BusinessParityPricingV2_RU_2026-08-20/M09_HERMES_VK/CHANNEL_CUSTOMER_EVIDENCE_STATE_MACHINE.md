# Channel ↔ Customer evidence state machine

```text
Guest
→ Candidate
→ Linked
├→ Rejected
└→ Revoked

Revoked/Candidate → Linked через audited Relink/Confirm
```

Link содержит opaque ChannelIdentityRef, CustomerRef, EvidenceKind, EvidenceRef/hash, actor, verifiedAt, lastSeenAt, version. Модель не выбирает VK user id/CustomerRef произвольно.

`channel-identity-broker` удостоверяет provider identity; Customer resolver выдаёт candidates; operator/customer proof переводит link в Linked.
