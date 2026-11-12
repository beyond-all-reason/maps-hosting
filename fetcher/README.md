fetcher
=======

Cloudflare Worker that fetches files from R2 buckets and serves them.

Fallback to springfiles is controlled by the `SPRINGFILES_FALLBACK` variable
(Pulumi config `springfilesFallback`, default `false`). When disabled, only
assets present in the CDN (maps uploaded via the GCS upload bucket, engines)
are served: maps missing in KV return 404 and `/find` with an unsupported
category returns 400. When enabled, missing maps are looked up in springfiles
and a caching request is published to Pub/Sub, and unsupported categories are
redirected to springfiles.

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
