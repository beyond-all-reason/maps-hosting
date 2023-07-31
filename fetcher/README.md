fetcher
=======

Publishing to GCS bucket
========================

```
npm run build
gcloud storage cp dist/index.js gs://bar-springfiles-dev_assets-upload/fetcher.js
cd ../infra
pulumi up -s dev
```
