# Headless lab client: werift (pure-TypeScript WebRTC) + ws.
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY lab-client.mjs ./
CMD ["node", "lab-client.mjs"]
