FROM node:20-alpine

WORKDIR /app

# Install from the lockfile for reproducible builds
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./

EXPOSE 3000

CMD ["node", "server.js"]
