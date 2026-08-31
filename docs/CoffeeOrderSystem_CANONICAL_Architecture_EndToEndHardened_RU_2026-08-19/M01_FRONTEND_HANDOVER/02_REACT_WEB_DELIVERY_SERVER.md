# 04. React Web Delivery Server

## 1. Терминология

React — browser UI runtime. Для production React build нужен web server, но при текущем `React Router SPA Mode (ssr:false)` **Node.js runtime server не обязателен**.

Целевой первый runtime:

```text
platform-web
= отдельный internal web workload
= Nginx static server
= immutable React/Vite build
```

Node.js используется на build-stage frontend image, а не обязан оставаться в runtime-stage.

## 2. Полная web delivery цепочка

```text
Browser
   |
   v
coffee-edge (public Nginx)
   |
   | /app/*
   v
platform-web (internal Nginx)
   |
   +-- index.html
   +-- hashed JS/CSS/assets
   +-- SPA deep-link fallback
   v
React application in browser
```

Browser API/realtime calls снова проходят через public edge:

```text
React -> /api/*    -> coffee-edge -> selected backend
React -> /events/* -> coffee-edge -> realtime-gateway
```

## 3. Почему сохраняем static Nginx runtime

Это минимальный и уже проверенный вариант:

- нет второго Node application process для static files;
- очень маленький runtime surface;
- immutable hashed assets;
- дешёвая horizontal replication;
- независимый frontend image/digest;
- естественный SPA fallback;
- сохраняется существующая CSP build pipeline;
- меньше переменных во время C#→TS migration.

## 4. Responsibilities `platform-web`

Разрешено:

- раздавать `/app/*` React document;
- раздавать hashed assets;
- SPA fallback;
- frontend-specific CSP include/header;
- asset compression;
- cache-control;
- health endpoint;
- access metrics/logging без PII.

Запрещено:

- business API;
- DB access;
- Kafka business producer;
- Customer/Order session truth;
- AROMA/payment calls;
- authentication decisions, кроме безопасной передачи/hosting browser application.

## 5. Public edge vs web server

| Ответственность | `coffee-edge` | `platform-web` |
|---|---:|---:|
| Public TLS | ✓ | ✗ |
| Public port | ✓ | ✗ |
| C#↔TS API strangler | ✓ | ✗ |
| `/events` proxy | ✓ | ✗ |
| VK callback proxy | ✓ | ✗ |
| React files | ✗ | ✓ |
| SPA fallback | ✗ | ✓ |
| React CSP artifact | may enforce outer policy | ✓ build-specific |
| immutable asset cache | proxy-compatible | ✓ owner |

## 6. Caching policy

Hashed assets:

```text
Cache-Control: public, max-age=31536000, immutable
```

HTML shell:

```text
no-cache/no-store or explicit revalidation
```

Точные значения должны сохранять текущую проверенную policy, пока отдельный performance ADR не изменит её.

## 7. Docker image

Target pattern:

```text
FROM node:<pinned-LTS>-alpine AS build
  pnpm install --frozen-lockfile
  pnpm build
  pnpm bundle:check

FROM nginx:<pinned>-alpine AS runtime
  copy nginx.conf
  copy CSP artifact
  copy build/client
```

Runtime image не содержит Node package manager, исходный TS или dev dependencies.

## 8. Health/readiness

Static web readiness означает:

- Nginx process жив;
- config valid;
- `index.html` существует;
- generated CSP file существует и был проверен при build.

Внешний API/Hermes/Kafka health **не должен** влиять на liveness `platform-web`.

## 9. Kubernetes

```text
Deployment/platform-web
Service/platform-web
```

Stateless, без persistent volumes и sticky session.

Scale по:

- HTTP RPS;
- connection count;
- CPU/network;
- p95 static response latency.

Чаще всего потребуется мало replicas, потому что static Nginx очень дешёвый.

## 10. Future Node SSR option

Если появится доказанная необходимость:

- SEO/public pages;
- server rendering;
- React Router server loaders;
- streaming document;
- BFF aggregation;

можно заменить **внутреннюю реализацию** `platform-web` на Node.js/TypeScript server.

Но это отдельный ADR. Public contract остаётся:

```text
coffee-edge /app/* -> platform-web
```

## 11. Почему SSR не включаем одновременно с backend rewrite

SSR изменяет:

- rendering lifecycle;
- caching;
- auth bootstrap;
- server/client data loading;
- error boundaries;
- deployment resource profile.

Одновременный SSR + frontend relocation + backend rewrite усложнит parity. Поэтому first target сохраняет SPA semantics.
