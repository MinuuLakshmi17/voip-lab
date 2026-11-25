# Signaling server image: builds the TypeScript server and client,
# then runs only the compiled output.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY server ./server
COPY client ./client
COPY scripts ./scripts
COPY vitest.config.ts ./
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
