FROM node:26.8.1-trixie-slim AS builder
RUN corepack pnpm install

FROM node:26.8.1-trixie-slim
COPY --from=builder /app/node_modules /app/node_modules
CMD ["node", "dist/main.js"]
