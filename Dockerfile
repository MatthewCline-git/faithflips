FROM node:22-bookworm-slim

WORKDIR /app

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
  && python3 -m pip install --break-system-packages --no-cache-dir yt-dlp \
  && corepack enable \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/evals/package.json packages/evals/package.json
COPY packages/ingestion/package.json packages/ingestion/package.json
COPY packages/model/package.json packages/model/package.json
COPY packages/prompts/package.json packages/prompts/package.json
COPY packages/rendering/package.json packages/rendering/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm -r build

EXPOSE 4001

CMD ["pnpm", "--filter", "@faithflips/api", "dev"]
