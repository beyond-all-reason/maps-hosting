cacher
======

Testing
-------

Create `cacher.env` with env variables set:

```
export CF_ACCOUNT_ID=
export CF_R2_BUCKET=
export CF_R2_ACCESS_KEY_ID=
export CF_R2_ACCESS_KEY_SECRET=
export CF_KV_NAMESPACE_ID=
export CF_KV_API_TOKEN=
export PYSMF_PATH=
```

and source. Make sure that pysmf works correctly (e.g. don't forget to source venv). Run app with `npm start`.

To test caching from spring files:

```
echo '{"category":"map","springname":"Angel Crossing 1.4"}' | base64 -w 0 | jq -R '{"message": {"attributes": {"requestType": "SyncRequest"}, "data": .}}' | curl -X POST -d @- http://localhost:8080/cache
```

To test uploading from GCS bucket:

```
echo '{"name":"map.sd7","bucket":"gcs-bucket-name"}' | base64 -w 0 | jq -R '{"message": {"attributes": {"eventType": "OBJECT_FINALIZE", "payloadFormat": "JSON_API_V1"}, "data": .}}' | curl -X POST -d @- http://localhost:8080/upload
```

Publishing
----------

To update already configured Cloud Run cacher instance:

```
podman build --format=docker .. -f Dockerfile -t europe-west1-docker.pkg.dev/$PROJECT_ID/main/cacher
podman push europe-west1-docker.pkg.dev/$PROJECT_ID/main/cacher
cd ../infra
pulumi up -s {dev|prod}
```

You can also use

```
gcloud --project=$PROJECT_ID run deploy cacher --region=europe-west1 --image europe-west1-docker.pkg.dev/$PROJECT_ID/main/cacher:latest
```

but it will cause some diffs for pulumi.
