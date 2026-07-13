FROM node:20-alpine

WORKDIR /plugin/backend
RUN apk add --no-cache docker-cli docker-cli-compose unzip tar

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/ ./
COPY public/ /plugin/public/

ENV NODE_ENV=production \
    PORT=3010 \
    APPSTORE_WORKDIR=/plugin/data \
    APPSTORE_TARGET_ROOT=/workspace/project \
    APPSTORE_PLUGIN_ROOT=/workspace/project/plugins

EXPOSE 3010
CMD ["npm", "start"]
