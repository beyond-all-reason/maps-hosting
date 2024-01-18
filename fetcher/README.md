fetcher
=======

Cloudflare Worker that fetches files from R2 buckets and serves them.

### Testing

In one shell run:

```
wrangler dev
```

In a different one run (It's using https://hurl.dev/):

```
hurl --test tests.hurl
```

### Publishing to GCS bucket

```
npm run build
gcloud storage cp dist/index.js gs://bar-springfiles-dev_assets-upload/fetcher.js
cd ../infra
pulumi up -s dev
```
