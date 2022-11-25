FROM docker.io/library/node:18 AS compile-env
COPY . .
WORKDIR cacher
RUN npm ci
RUN npm run tsc

FROM docker.io/library/node:18 AS install-env
WORKDIR /app
COPY --from=compile-env /cacher/package* ./
COPY --from=compile-env /cacher/dist .
RUN npm ci --omit=dev

FROM docker.io/debian:bookworm AS pysml
WORKDIR /app
RUN apt-get update && apt-get install --no-install-recommends -yq \
    ca-certificates git 
RUN git clone --depth 1 https://github.com/p2004a/pysmf.git

FROM docker.io/debian:bookworm-slim
RUN apt-get update \
 && apt-get install -yq --no-install-recommends \
 	curl bash python3-minimal python3-pip ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
 && apt-get update \
 && apt-get install -yq --no-install-recommends nodejs
COPY --from=install-env /app /app
COPY --from=pysml /app/pysmf/requirements.txt /app/requirements.txt
COPY --from=pysml /app/pysmf/pysmf.py /app/pysmf.py
RUN pip install -r /app/requirements.txt
WORKDIR /app
ENV PYSMF_PATH=/app/pysmf.py
CMD ["node", "--enable-source-maps", "cacher/src/index.js"]
