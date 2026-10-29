ARG NODE_IMAGE
FROM ${NODE_IMAGE}
WORKDIR /fixture
COPY backend.mjs ./backend.mjs
USER 10001:10001
CMD ["node", "backend.mjs"]
