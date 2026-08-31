# Agent session, rate and dedupe limits

На Channel ingress сохраняются provider event id/hash и dedupe key. Повтор того же события не создаёт второй AgentTurn.

Per identity/conversation применяются configurable rate limits и bounded queue. Hermes submission использует durable TurnJournal и OwnerEpoch.

Лимиты должны существовать для:

- max input chars;
- max order lines;
- max quantity per line/order;
- max tool calls/turn;
- max steps/turn;
- hard/soft timeout;
- max concurrent mutation-capable turn = 1 per conversation.
