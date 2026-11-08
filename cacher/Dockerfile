FROM docker.io/library/node:26-trixie-slim
RUN apt-get update \
 && apt-get install -yq --no-install-recommends \
 	python3-minimal python3-pip ca-certificates 7zip \
 && rm -rf /var/lib/apt/lists/*
COPY cacher/pysmf/requirements.txt /app/cacher/pysmf/requirements.txt
RUN pip install --no-cache-dir --break-system-packages --root-user-action=ignore \
    -r /app/cacher/pysmf/requirements.txt
WORKDIR /app/cacher
COPY cacher/package.json cacher/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY cacher/pysmf/pysmf.py pysmf/pysmf.py
COPY lib/package.json lib/index.ts /app/lib/
COPY cacher/src src
ENV PYSMF_PATH=/app/cacher/pysmf/pysmf.py
USER node
CMD ["node", "src/index.ts"]
