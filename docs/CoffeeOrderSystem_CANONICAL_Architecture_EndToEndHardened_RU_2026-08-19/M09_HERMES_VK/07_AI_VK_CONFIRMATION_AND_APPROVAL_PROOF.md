# M09. AI/VK confirmation и trusted approval proof

## 1. Принятое target-решение

Hermes/LLM **не имеет права сам создать доказательство подтверждения заказа**.

Нормальный AI/VK путь теперь:

```text
Draft
  ↓ prepare_confirmation
OrderConfirmationChallenge
  ↓ VK structured button/callback
ChannelConfirmationProof
  ↓ trusted backend command
Draft -> Confirmed
```

Target normal-path **не оставляет Confirmed Order бесконечно в `Approval=Pending`**.

`Approval=Pending` допускается только как migration/manual-review fallback с явной операторской очередью и expiry.

## 2. OrderConfirmationChallenge

Orders создаёт immutable challenge:

```text
confirmationChallengeRef
orderRef
orderVersion
summaryHash
customerRef
channelIdentityRef
identityEpoch
expiresAtUtc
status = Pending | Consumed | Expired | Cancelled
```

Challenge инвалидируется любой mutation Order, меняющей summary/orderVersion.

## 3. Trusted ChannelConfirmationProof

Предпочтительный production UX — кнопка VK `Подтвердить заказ` с opaque signed callback payload.

`channel-ingress` проверяет provider callback и передаёт raw identity только в Channel Identity Broker. После attestation создаётся proof:

```text
confirmationProofRef
confirmationChallengeRef
channelIdentityRef
identityEpoch
providerEventRef
receivedAtUtc
proofType = StructuredChannelCallback
```

Proof создаётся transport/backend-кодом. Hermes не передаёт `customerId`, `vkUserId`, произвольный `channelIdentityRef` или самодельный proof.

## 4. Confirmation execution

Trusted channel handler либо `agent-v1` с injected trusted proof выполняет `ConfirmCurrentOrder`.

Orders проверяет:

1. challenge существует и Pending;
2. не истёк;
3. current OrderVersion совпадает;
4. summaryHash совпадает;
5. proof относится к тому же challenge;
6. `channelIdentityRef + identityEpoch` соответствует challenge;
7. Customer resolution совпадает;
8. proof не использован ранее.

В одной Orders transaction:

```text
Draft -> Confirmed
challenge -> Consumed
Desired Approval = Approved
history
Outbox
```

## 5. Free-text «да»

Свободный текст не является криптографическим/transport proof. Модель может распознать намерение и предложить пользователю structured confirmation, но не заменяет кнопку.

Если provider UI недоступен, fallback — операторское подтверждение:

```text
ApproveAgentOrder(expectedVersion, actor, reason)
```

Операторская команда создаёт `OperatorApprovalProof` и подтверждает текущую версию заказа.

## 6. Failed/expired approval

- challenge expired -> заказать новый summary/challenge;
- changed OrderVersion -> old challenge invalid;
- relink/identityEpoch changed -> proof rejected, требуется повторная идентификация;
- duplicate provider callback -> idempotent no-op по providerEventRef/proofRef.

## 7. EDA impact

`AgentTurnRequested` может содержать только `confirmationProofRef` из trusted channel context, не raw callback secret. `AgentTurnCompleted/Failed` никогда не создают approval сами.
