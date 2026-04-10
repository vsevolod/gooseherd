FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM gooseherd/sandbox:default

USER root
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ dist/
COPY pipelines/ pipelines/

RUN mkdir -p /work \
  && chown -R gooseherd:gooseherd /app /work

USER gooseherd

ENV WORK_ROOT=/work
ENV DASHBOARD_ENABLED=false
ENV OBSERVER_ENABLED=false
ENV SUPERVISOR_ENABLED=false

CMD ["node", "dist/runner/index.js"]
