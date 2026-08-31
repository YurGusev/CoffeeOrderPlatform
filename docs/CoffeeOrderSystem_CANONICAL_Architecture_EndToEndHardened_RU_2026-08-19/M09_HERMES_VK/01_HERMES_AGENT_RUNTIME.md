# 11. Hermes production Agent Runtime

## 1. Роль

Hermes ведёт:

- agent loop;
- model/tool orchestration;
- conversation transcript;
- runtime sessions;
- provider routing.

CoffeeOrder business truth остаётся в TypeScript platform/PostgreSQL.

## 2. Production profile

Отдельный `coffeeorder` profile, не developer Hermes.

Разрешены только CoffeeOrder tools.

Запрещены универсальные capabilities:

```text
terminal/shell
file write
arbitrary browser/web
code execution
sudo
GitHub
unrestricted MCP
delegation/subagents
```

## 3. CoffeeOrder Plugin

Plugin остаётся тонким protocol/security adapter:

```text
Hermes tool
  -> fixed agent-v1 HTTP call
  -> TypeScript `api-agent` / agent-v1
```

Не содержит price/order/customer business logic.

## 4. Customer resolution

Hermes сам решает, когда вызвать:

```text
resolve_current_customer()
```

Tool не принимает `vk_user_id/customerId`. Trusted channel identity injects plugin/runtime context.

## 5. Runtime Pool

Hermes stateful; целевая модель:

```text
hermes-runtime-0 -> own state volume
hermes-runtime-1 -> own state volume
...
```

Dispatcher хранит external binding `ConversationKeyHash -> shard/session/OwnerEpoch`.

## 6. Model routing

Server-side aliases:

```text
coffee-primary
coffee-fallback
coffee-local
coffee-shadow
```

Пользователь не может менять route/model.

## 7. AReaL

AReaL не запускается в production path. Он используется позже для sanitized trajectory/evaluation/RL workflow.
