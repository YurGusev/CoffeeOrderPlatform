# M19. Exact OpenAPI route canon

Canonical HTTP prefixes are **always**:

```text
/api/client-v1
/api/agent-v1
/api/internal-v1
```

Provider webhooks use explicit non-generic path:

```text
/channels/vk/callback
/webhooks/payments/{provider}
```

Machine-readable specs:

```text
M19_API_ARCHITECTURE/openapi/client-v1.yaml
M19_API_ARCHITECTURE/openapi/agent-v1.yaml
M19_API_ARCHITECTURE/openapi/internal-v1.yaml
```

Markdown route examples are explanatory only. CI lints documented absolute routes against these specs.
