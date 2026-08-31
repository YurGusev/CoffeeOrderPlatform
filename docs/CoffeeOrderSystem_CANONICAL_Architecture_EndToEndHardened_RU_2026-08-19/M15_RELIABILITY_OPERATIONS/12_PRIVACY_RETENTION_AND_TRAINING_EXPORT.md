# M15. Channel/Agent privacy, retention и training export

## Kafka classification

`channels.inbound`, `agent.turn.requested`, `agent.turn.completed`, `channels.outbound` are:

```text
user-generated-content / possible-PII
```

Они не классифицируются как opaque refs only.

## Minimization

- raw VK/provider IDs excluded; use ChannelIdentityRef/ConversationRef;
- message text only where required for current turn/reply;
- attachment binary not in Kafka, only ArtifactRef;
- phone/address/customer details не дублируются в envelope metadata;
- logs/traces redact message text by default.

## Retention baseline

- channel/agent message Kafka payloads: 7 days;
- delivery/error metadata: 30 days;
- business Order/Invoice/Payment facts: according business retention;
- Hermes transcript: 30 days online by default, then delete/anonymize unless explicit support/audit hold;
- training export source is separate sanitized dataset, never direct topic/state.db dump.

## Training export

Pipeline:

```text
eligible trajectories
 -> PII detector/redactor
 -> raw provider identity removal
 -> customer/address/phone tokenization
 -> policy filter
 -> human/automated quality labels
 -> immutable sanitized dataset version
```

Production secrets, ChannelIdentity raw hashes and payment metadata are excluded.
