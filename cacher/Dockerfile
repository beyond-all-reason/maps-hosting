FROM docker.io/library/node:26-trixie-slim
RUN apt-get update \
 && apt-get install -yq --no-install-recommends \
 	python3-minimal python3-seccomp ca-certificates 7zip \
 && rm -rf /var/lib/apt/lists/*
COPY cacher/pysmf/pyproject.toml cacher/pysmf/uv.lock /app/cacher/pysmf/
RUN --mount=from=ghcr.io/astral-sh/uv:0.13.9,source=/uv,target=/usr/local/bin/uv \
 uv venv --python /usr/bin/python3 --system-site-packages /app/cacher/pysmf/.venv \
 && uv sync --no-cache --project /app/cacher/pysmf --locked --no-install-project --no-dev
WORKDIR /app/cacher
COPY cacher/package.json cacher/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY cacher/pysmf/pysmf.py cacher/pysmf/test_pysmf.py pysmf/
COPY lib/package.json lib/index.ts /app/lib/
COPY cacher/src src
ENV PATH="/app/cacher/pysmf/.venv/bin:${PATH}"
ENV PYSMF_PATH=/app/cacher/pysmf/pysmf.py
USER node
RUN python3 pysmf/test_pysmf.py
CMD ["node", "src/index.ts"]
