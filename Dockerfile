# Lead Pipeline: Node 22 (built-in SQLite). Two npm packages, used only by the dialer's AI call notes.
FROM node:22-slim

ENV NODE_ENV=production
# ffmpeg sizes the social media photos and makes the Reels and Shorts; the font draws the words on them.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .

# Leads are stored on the persistent volume mounted at /data (see fly.toml).
ENV DB_PATH=/data/leads.db
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
