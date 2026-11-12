maps-hosting
============

Application for serving Recoil RTS assets, at the moment maps using API
compatible with [pr-downloader](https://github.com/beyond-all-reason/pr-downloader)
(simulating required part of functionality of
https://springfiles.springrts.com/json.php endpoint) using Cloudflare Workers
and R2.

Maps are only served if they were uploaded to the GCS upload bucket. Fallback to
springfiles for missing maps can be enabled with the `springfilesFallback`
Pulumi config, but is disabled by default.
