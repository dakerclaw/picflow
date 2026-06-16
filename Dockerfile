FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY src/ ./src/

RUN mkdir -p uploads data

ENV NODE_ENV=production
ENV PORT=3000
ENV JWT_SECRET=change-me-to-a-random-string
ENV UPLOAD_DIR=/app/uploads
ENV DB_PATH=/app/data/picflow.db

VOLUME ["/app/uploads", "/app/data"]
EXPOSE 3000
CMD ["node", "src/index.js"]
