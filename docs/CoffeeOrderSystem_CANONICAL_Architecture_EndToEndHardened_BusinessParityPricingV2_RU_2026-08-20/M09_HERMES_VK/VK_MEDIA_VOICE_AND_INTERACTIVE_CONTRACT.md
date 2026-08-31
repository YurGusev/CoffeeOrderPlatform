# VK media, voice and interactive contract

## Voice/media ingest

```text
VK event
→ channel-ingress validates provider metadata
→ download through fixed VK-origin client
→ Artifact Storage quarantine
→ size/type/hash/malware policy
→ transcription worker
→ sanitized transcript artifact
→ normal ChannelMessageReceived/AgentTurn
```

Ограничения размера/типа server-side. URL из payload не является произвольным SSRF target.

## Interactive messages

Keyboard/carousel callback содержит signed/versioned opaque action token, ConversationRef, action kind, expiry и anti-replay nonce. Business command всегда выполняет owner API, а не Channel runtime.

Outbound использует provider `random_id`/idempotency mapping и сохраняет delivery result.
