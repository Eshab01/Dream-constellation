# Zero-dependency Node app — no npm install step needed.
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json server.js ./
COPY public ./public
# /data is where hosts mount the persistent volume (set DATA_DIR=/data).
# The server seeds data/dreams.json on first run if the volume is empty.
RUN mkdir -p /data
EXPOSE 4173
CMD ["node", "server.js"]
