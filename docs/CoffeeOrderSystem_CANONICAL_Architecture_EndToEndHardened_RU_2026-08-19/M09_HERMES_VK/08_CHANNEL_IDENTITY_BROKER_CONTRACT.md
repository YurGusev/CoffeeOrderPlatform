# M09. Channel Identity Broker contract

## 1. Owner

`channel-identity-broker` — Channel Platform-owned Node workload с отдельным DB principal/schema `channel_identity`.

Он владеет технической attestation identity, но **не customer linkage**.

## 2. Exact internal API

```text
POST /api/internal-v1/channel-identities/attest
```

Доступ только `channel-ingress` service audience.

Input содержит provider-normalized raw subject/peer identity внутри private request. Raw provider identifiers не возвращаются downstream.

Output:

```text
channelIdentityRef
conversationRef
identityEpoch          # decimal string
conversationType       # Direct | Group
attestationRef
```

## 3. Ledger

```text
ChannelIdentityLedger
- channelIdentityRef
- provider
- providerSubjectHash
- providerConversationHash
- conversationType
- identityEpoch
- status
- firstSeenAtUtc
- lastSeenAtUtc
```

Uniqueness: `(provider, providerSubjectHash, providerConversationHash, conversationType)`.

## 4. Epoch

Epoch увеличивается при provider identity reset/rebinding/security rotation. Downstream Customer link с предыдущим epoch становится `RequiresRevalidation`.

## 5. Group chat

`conversationRef` и sender `channelIdentityRef` — разные identities. Customer resolution всегда относится к sender, не room.

## 6. Retention

Raw provider identifiers не сохраняются; salted/hash normalized identifiers и opaque refs хранятся столько, сколько требуется для dedupe/security linkage. Secret salt/pepper находится в secret manager, не Git/DB.
