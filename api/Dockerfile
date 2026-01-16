# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# libuv 스레드 풀 사이즈 (기본값 4, 최대 1024)
ENV UV_THREADPOOL_SIZE=4
ENV NODE_ENV=production

# curl 설치 (헬스체크용)
RUN apk add --no-cache curl

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./

# 임시 파일용 디렉토리 (파일 I/O 시나리오용)
RUN mkdir -p /tmp/uploads && chmod 777 /tmp/uploads

EXPOSE 3000

CMD ["node", "dist/main.js"]
