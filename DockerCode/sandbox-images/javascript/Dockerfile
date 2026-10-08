FROM node:22-alpine
RUN addgroup -g 10001 runner && adduser -D -u 10001 -G runner runner
WORKDIR /workspace
USER 10001:10001
