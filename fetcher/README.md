fetcher
=======

Publishing to GCS bucket
========================

```
./node_modules/wrangler/bin/wrangler.js publish --dry-run --outdir dist
gcloud storage cp dist/index.js gs://bar-springfiles-syncer_worker-scripts/fetcher.js
```
