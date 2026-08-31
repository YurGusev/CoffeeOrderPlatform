# M09. Политика маршрутизации моделей Hermes

## 1. Model portability

Business architecture не зависит от конкретного model vendor.

Используются route aliases:

```text
coffee-primary
coffee-fallback
coffee-local
coffee-shadow
coffee-evaluator
```

Server-side policy сопоставляет alias с provider/model/options.

## 2. User/model не управляет routing

VK user и LLM не могут произвольно переключать production provider/model. `/model`-подобные developer capabilities в CoffeeOrder profile запрещены или недоступны channel runtime.

## 3. Provider classes

Допустимы:

- commercial programmable APIs;
- validated custom OpenAI-compatible endpoints;
- local Ollama/vLLM/SGLang;
- subscription/OAuth только в рамках явно допустимого use case и без предположения production SLA.

## 4. Certification

Каждый provider проходит smoke/contract suite:

```text
auth
model discovery
text generation
tool calls
sequential tool calls
streaming/cancellation
long context
malformed tool handling
429/5xx/timeout behavior
usage accounting
```

## 5. Fallback

Fallback разрешён только для model/provider transport/capacity failures.

Не использовать fallback как повтор business mutation. Backend idempotency гарантирует, что provider retry не дублирует side effect.

## 6. Local model lifecycle

```text
base model
→ SFT/QLoRA
→ optional AReaL agentic RL
→ offline eval
→ Hermes shadow
→ canary
→ coffee-local production alias
```

## 7. Telemetry

На каждый run:

```text
route alias
provider/model version
TTFT
full latency
input/output tokens
fallback count/reason
cost where available
error class
```
