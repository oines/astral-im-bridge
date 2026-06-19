FROM node:26-bookworm-slim

WORKDIR /app

RUN npm install -g pnpm@10.31.0

COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile

COPY src ./src
RUN pnpm build && pnpm prune --prod

CMD ["node", "dist/index.js", "--config", "/config/bridge.json"]
