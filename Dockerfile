# YM-TRANSIT ERP — image de production (Coolify, build pack « Dockerfile »)
FROM node:22-bookworm-slim

# OpenSSL est requis par le moteur Prisma
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dépendances (couche mise en cache tant que package*.json ne change pas)
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# Code source + build (client Prisma, front, serveur et seed)
COPY . .
RUN npm run build

# DATABASE_URL (PostgreSQL) se définit dans Coolify, voir .env.example
ENV NODE_ENV=production \
    PORT=3000 \
    UPLOADS_PATH=/app/uploads

# /app/data : sauvegardes quotidiennes, clés push et ancienne base SQLite à reprendre ; /app/uploads : pièces jointes.
# Montez des volumes persistants sur ces deux dossiers.
RUN mkdir -p /app/data /app/uploads
VOLUME ["/app/data", "/app/uploads"]

EXPOSE 3000

# prisma-check.js synchronise le schéma PostgreSQL sans perte de données (et reprend prod.db une seule fois), puis le serveur démarre
CMD ["sh", "-c", "node prisma-check.js && node dist/server.cjs"]
