FROM docker.io/library/node:18 AS compile-env

COPY . .
WORKDIR cacher
RUN npm ci
RUN npm run tsc

FROM docker.io/library/node:18 AS install-env
WORKDIR /app
COPY --from=compile-env /cacher/package* .
COPY --from=compile-env /cacher/dist .
RUN npm ci --omit=dev

FROM gcr.io/distroless/nodejs:18
COPY --from=install-env /app /app
WORKDIR /app
CMD ["--enable-source-maps", "cacher/src/index.js"]
