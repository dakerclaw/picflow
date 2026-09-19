FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY src/ ./src/

RUN mkdir -p uploads data

ENV NODE_ENV=production
ENV PORT=3000
# 刻意不设 JWT_SECRET：留空时服务端会自己生成随机密钥并存到 /app/data/.jwt-secret。
# 在这里写死一个固定值，等于把「伪造令牌绕过访问密码」的能力交给所有人。
ENV UPLOAD_DIR=/app/uploads
ENV DB_PATH=/app/data/picflow.db

VOLUME ["/app/uploads", "/app/data"]
EXPOSE 3000
CMD ["node", "src/index.js"]
