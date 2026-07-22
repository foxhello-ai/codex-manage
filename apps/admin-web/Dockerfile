FROM node:22-alpine AS build
WORKDIR /app
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
COPY package.json ./
RUN npm install
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
ARG VITE_CONTROL_API_URL=https://codex-api.xmwefun.cn
ENV VITE_CONTROL_API_URL=$VITE_CONTROL_API_URL
RUN npm run build

FROM nginx:1.29-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
