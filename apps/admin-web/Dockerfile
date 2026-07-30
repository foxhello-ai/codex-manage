FROM node:22-alpine AS build
WORKDIR /app
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
COPY package.json ./
RUN npm install
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
ARG VITE_CONTROL_API_URL=https://codex-api.foxhello.com
ENV VITE_CONTROL_API_URL=$VITE_CONTROL_API_URL
RUN npm run build

FROM nginx:1.29-alpine
ENV CODEX_ADMIN_CONTROL_API_URL=https://codex-api.foxhello.com
ENV CODEX_ADMIN_CONTROL_API_PORT=4320
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["/bin/sh", "-c", "printf 'window.CODEX_ADMIN_CONFIG = { controlApiUrl: \"%s\", controlApiPort: \"%s\" };\\n' \"$CODEX_ADMIN_CONTROL_API_URL\" \"$CODEX_ADMIN_CONTROL_API_PORT\" > /usr/share/nginx/html/admin-config.js && exec nginx -g 'daemon off;'"]
