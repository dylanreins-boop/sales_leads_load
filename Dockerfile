# Lead Pipeline: no npm packages needed, just Node 22 (built-in SQLite).
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app
COPY . .

# Leads are stored on the persistent volume mounted at /data (see fly.toml).
ENV DB_PATH=/data/leads.db
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
