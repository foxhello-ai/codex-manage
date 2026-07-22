FROM node:22-alpine AS build
WORKDIR /app
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 4320
CMD ["node", "dist/index.js"]
