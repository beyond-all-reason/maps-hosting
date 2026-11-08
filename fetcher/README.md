fetcher
=======

Cloudflare Worker that fetches files from R2 buckets and serves them.

The deployed worker and its bindings are managed by Pulumi in `../infra`;
`wrangler.jsonc` only configures local development and tests.

### Development

```
npm ci
npm run typecheck  # regenerates worker-configuration.d.ts with `wrangler types`
npm test
npm run dev
```

Tests don't access the network: all outbound requests (springfiles, Google
OAuth and Pub/Sub) are mocked.

### Publishing to GCS bucket

```
npm run build
gcloud storage cp dist/index.js gs://bar-springfiles-dev_worker-scripts/fetcher.js
cd ../infra
pulumi up -s dev
```

or just use `../infra/deploy.sh dev`.
