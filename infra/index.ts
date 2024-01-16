import * as cloudflare from "@pulumi/cloudflare";
import * as docker from "@pulumi/docker";
import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

const config = new pulumi.Config();
const region = config.require("region");

/*
Cloudflate API Token needed for this config requires following Edit permissions:

User
  API Tokens  # Only visible via "Create Additional Tokens" in API Tokens page
Account
  Worker R2 Storage
  Worker KV Storage
  Worker Scripts
Zone
  Worker Routes
  DNS
*/

const fetcherAssetsKv = new cloudflare.WorkersKvNamespace("fetcher-assets-kv", {
    title: `fetcher-${pulumi.getStack()}:assets`,
    accountId: config.require("cloudflareAccountId"),
});

if (pulumi.getStack() == "dev") {
    new cloudflare.WorkersKvNamespace("fetcher-assets-kv-preview", {
        title: `fetcher-${pulumi.getStack()}:assets_preview`,
        accountId: config.require("cloudflareAccountId"),
    });
}

const cfPermissionGroups = pulumi.output(cloudflare.getApiTokenPermissionGroups()).permissions;

const fetcherAssetsKvApiToken = new cloudflare.ApiToken("fetcher-assets-kv-api-token", {
    name: `cacher-${pulumi.getStack()} access`,
    policies: [{
        permissionGroups: [cfPermissionGroups.apply(p => p['Workers KV Storage Write'])],
        resources: {[`com.cloudflare.api.account.${config.require("cloudflareAccountId")}`]: "*"}
    }]
});

const fetcherAssetsBucketSuffix = new random.RandomInteger("fetcher-assets-bucket-suffix", {
    max: 999,
    min: 100,
});

const fetcherAssetsBucket = new cloudflare.R2Bucket("fetcher-assets-bucket", {
    accountId: config.require("cloudflareAccountId"),
    name: pulumi.interpolate `fetcher-${pulumi.getStack()}-assets-${fetcherAssetsBucketSuffix.result}`,
});

// Create regional R2 buckets for each region we want to serve from.
// https://developers.cloudflare.com/r2/reference/data-location/
const fetcherAssetsBuckets = ['weur', 'wnam', 'apac']
    .map(region => new cloudflare.R2Bucket(`fetcher-assets-bucket-${region}`, {
        accountId: config.require("cloudflareAccountId"),
        name: pulumi.interpolate `fetcher-${pulumi.getStack()}-assets-${region}-${fetcherAssetsBucketSuffix.result}`,
        location: region.toUpperCase(),
    }));

const gcpServiceSecretManager = new gcp.projects.Service("gcp-service-secretmanager", {
    service: "secretmanager.googleapis.com",
});

const gcpServiceArtifactRegistry = new gcp.projects.Service("gcp-service-artifactregistry", {
    service: "artifactregistry.googleapis.com",
});

const gcpServiceRun = new gcp.projects.Service("gcp-service-run", {
    service: "run.googleapis.com",
});

const cacher = new gcp.serviceaccount.Account("cacher", {
    accountId: "cacher",
    displayName: "cacher",
});

const cacherInvoker = new gcp.serviceaccount.Account("cacher-invoker", {
    accountId: "cacher-invoker",
    displayName: "cacher-invoker",
});

const fetcherWorker = new gcp.serviceaccount.Account("fetcher-worker", {
    accountId: "fetcher-worker",
    description: "CloudFlare fetcher worker script",
    displayName: "Fetcher Worker",
});

const uploadBucket = new gcp.storage.Bucket("upload-bucket", {
    lifecycleRules: [{
        action: {
            type: "Delete",
        },
        condition: {
            age: 1,
            withState: "ANY",
        },
    }],
    location: region,
    name: pulumi.interpolate `${gcp.organizations.getProjectOutput().projectId}_assets-upload`,
    publicAccessPrevention: "enforced",
    uniformBucketLevelAccess: true,
});

const uploadBucketContributorsAccess = new gcp.storage.BucketIAMMember("upload-bucket-contributors-access", {
    bucket: uploadBucket.id,
    role: "roles/storage.objectCreator",
    member: "group:beyondallreasondev@googlegroups.com",
});

const uploadBucketCacherAccess = new gcp.storage.BucketIAMMember("upload-bucket-cacher-access", {
    bucket: uploadBucket.id,
    role: "roles/storage.objectViewer",
    member: pulumi.interpolate `serviceAccount:${cacher.email}`,
});

const workerScriptsBucket = new gcp.storage.Bucket("worker-scripts-bucket", {
    location: region,
    name: pulumi.interpolate `${gcp.organizations.getProjectOutput().projectId}_worker-scripts`,
    publicAccessPrevention: "enforced",
    uniformBucketLevelAccess: true,
});

const workerScriptBucketFile = "fetcher.js";

export const workerScriptUploadTarget = pulumi.interpolate `${workerScriptsBucket.url}/${workerScriptBucketFile}`; 

const mainImagesRepo = new gcp.artifactregistry.Repository("main-images-repo", {
    format: "docker",
    location: region,
    repositoryId: "main",
}, {dependsOn: [gcpServiceArtifactRegistry]});

const mainRepoRegistryAddress = pulumi.interpolate `${mainImagesRepo.location}-docker.pkg.dev`;

const dockerProvider = new docker.Provider("docker", {
    registryAuth: [{
        address: mainRepoRegistryAddress,
        configFileContent: mainRepoRegistryAddress.apply(addr => JSON.stringify({
            credHelpers: {
                [addr]: "gcloud"
            }
        }))
    }]
}, {dependsOn: [mainImagesRepo]});

const cacherRegistryImage = docker.getRegistryImageOutput({
    name: pulumi.interpolate `${mainRepoRegistryAddress}/${mainImagesRepo.project}/${mainImagesRepo.repositoryId}/cacher:latest`,
}, {provider: dockerProvider});

export const cacherImageName = cacherRegistryImage.name;

const cfKvApiTokenSecret = new gcp.secretmanager.Secret("cloudflare-kv-api-token-secret", {
    replication: {
        userManaged: {
            replicas: [{
                location: region,
            }],
        },
    },
    secretId: "cloudflare-kv-api-token",
}, {dependsOn: [gcpServiceSecretManager]});

const cacherCfKvApiTokenSecretAccess = new gcp.secretmanager.SecretIamMember("cloudflare-kv-api-token-secret-cacher-access", {
    secretId: cfKvApiTokenSecret.secretId,
    role: "roles/secretmanager.secretAccessor",
    member: pulumi.interpolate `serviceAccount:${cacher.email}`,
});

const cfKvApiTokenSecretVersion = new gcp.secretmanager.SecretVersion("cloudflare-kv-api-token-secret-version", {
    secret: cfKvApiTokenSecret.id,
    secretData: fetcherAssetsKvApiToken.value,
});

const cfR2AccessKeySecret = new gcp.secretmanager.Secret("cloudflare-r2-access-key-secret", {
    replication: {
        userManaged: {
            replicas: [{
                location: region,
            }],
        },
    },
    secretId: "cloudflare-r2-access-key-secret",
}, {dependsOn: [gcpServiceSecretManager]});

const cacherR2AccessKeyAccess = new gcp.secretmanager.SecretIamMember("cloudflare-r2-access-key-secret-cacher-access", {
    secretId: cfR2AccessKeySecret.secretId,
    role: "roles/secretmanager.secretAccessor",
    member: pulumi.interpolate `serviceAccount:${cacher.email}`,
});

const cfR2AccessKeySecretVersion = new gcp.secretmanager.SecretVersion("cloudflare-r2-access-key-secret-version", {
    secret: cfR2AccessKeySecret.id,
    secretData: config.require("cfR2AccessKeySecret"),
});

const cacherService = new gcp.cloudrun.Service("cacher-service", {
    name: "cacher",
    location: region,
    autogenerateRevisionName: true,
    template: {
        metadata: {
            annotations: {
                "autoscaling.knative.dev/maxScale": "100",
                "run.googleapis.com/execution-environment": "gen2",
            },
            labels: {
                "run.googleapis.com/startupProbeType": "Default",
            },
        },
        spec: {
            containerConcurrency: 2,
            containers: [{
                envs: [{
                    name: "CF_ACCOUNT_ID",
                    value: config.require("cloudflareAccountId"),
                }, {
                    name: "CF_KV_API_TOKEN",
                    valueFrom: {
                        secretKeyRef: {
                            key: cfKvApiTokenSecretVersion.version,
                            name: cfKvApiTokenSecret.secretId,
                        },
                    },
                },{
                    name: "CF_KV_NAMESPACE_ID",
                    value: fetcherAssetsKv.id,
                },{
                    name: "CF_R2_ACCESS_KEY_ID",
                    value: config.require("cfR2AccessKeyId"),
                },{
                    name: "CF_R2_ACCESS_KEY_SECRET",
                    valueFrom: {
                        secretKeyRef: {
                            key: cfR2AccessKeySecretVersion.version,
                            name: cfR2AccessKeySecret.secretId,
                        },
                    },
                },{
                    name: "CF_R2_BUCKETS",
                    value: pulumi
                        .all(fetcherAssetsBuckets
                            .map(bucket => bucket.name)
                            .concat([fetcherAssetsBucket.name]))
                        .apply(names => names.join(",")),
                }],
                image: pulumi.interpolate `${cacherRegistryImage.name}@${cacherRegistryImage.sha256Digest}`,
                ports: [{
                    containerPort: 8080,
                    name: "http1",
                }],
                resources: {
                    limits: {
                        cpu: "1000m",
                        memory: "1Gi",
                    },
                },
            }],
            serviceAccountName: cacher.email,
            timeoutSeconds: 600,
        },
    },
    traffics: [{
        latestRevision: true,
        percent: 100,
    }],
}, {dependsOn: [cacherCfKvApiTokenSecretAccess, cacherR2AccessKeyAccess, gcpServiceRun]});

const cacherServiceInvoker = new gcp.cloudrun.IamMember("cacher-service-invoker-access", {
    location: region,
    service: cacherService.name,
    role: "roles/run.invoker",
    member: pulumi.interpolate `serviceAccount:${cacherInvoker.email}`,
});

const cacheRequests = new gcp.pubsub.Topic("cache-requests", {
    name: "cache-requests",
});

const cacheRequestsPolicy = new gcp.pubsub.TopicIAMPolicy("cache-requests-policy", {
    policyData: gcp.organizations.getIAMPolicyOutput({
        bindings: [{
            role: "roles/pubsub.publisher",
            members: [pulumi.interpolate `serviceAccount:${fetcherWorker.email}`]
        }]
    }).apply(p => p.policyData),
    topic: cacheRequests.id
});

const cacherSub = new gcp.pubsub.Subscription("cacher-sub", {
    ackDeadlineSeconds: 600,
    expirationPolicy: {
        ttl: "",
    },
    messageRetentionDuration: "7200s",
    name: "cacher-sub",
    pushConfig: {
        oidcToken: {
            serviceAccountEmail: cacherInvoker.email,
        },
        pushEndpoint: pulumi.interpolate `${cacherService.statuses[0].url}/cache`,
    },
    retryPolicy: {
        maximumBackoff: "600s",
        minimumBackoff: "10s",
    },
    topic: cacheRequests.id,
});

const uploadRequests = new gcp.pubsub.Topic("upload-requests", {
    name: "upload-requests",
});

const gcsAccount = gcp.storage.getProjectServiceAccountOutput({});

const uploadRequestsPolicy = new gcp.pubsub.TopicIAMPolicy("upload-requests-policy", {
    policyData: gcp.organizations.getIAMPolicyOutput({
        bindings: [{
            role: "roles/pubsub.publisher",
            members: [pulumi.interpolate `serviceAccount:${gcsAccount.emailAddress}`]
        }]
    }).apply(p => p.policyData),
    topic: uploadRequests.id,
});

const uploadRequestsSub = new gcp.pubsub.Subscription("upload-requests-sub", {
    ackDeadlineSeconds: 600,
    expirationPolicy: {
        ttl: "",
    },
    messageRetentionDuration: "7200s",
    name: "upload-requests-sub",
    pushConfig: {
        oidcToken: {
            serviceAccountEmail: cacherInvoker.email,
        },
        pushEndpoint: pulumi.interpolate `${cacherService.statuses[0].url}/upload`,
    },
    retryPolicy: {
        maximumBackoff: "600s",
        minimumBackoff: "10s",
    },
    topic: uploadRequests.id,
});

const uploadBucketNotification = new gcp.storage.Notification("upload-bucket-notification", {
    bucket: uploadBucket.name,
    eventTypes: ["OBJECT_FINALIZE"],
    payloadFormat: "JSON_API_V1",
    topic: uploadRequests.id,
}, {dependsOn: [uploadRequestsPolicy, uploadBucket]});

const fetcherWorkerKey = new gcp.serviceaccount.Key("mykey", {
    serviceAccountId: fetcherWorker.name,
});

const fetcherScriptContent = gcp.storage.getBucketObjectContentOutput({
    // This apply is purely to not fetch file before bucket exists.
    bucket: workerScriptsBucket.id.apply(_ => workerScriptsBucket.name),
    name: workerScriptBucketFile,
});

const fetcherWorkerScript = new cloudflare.WorkerScript("fetcher", {
    accountId: config.require("cloudflareAccountId"),
    name: `fetcher-${pulumi.getStack()}`,
    content: <pulumi.Output<string>>fetcherScriptContent.content,
    module: true,
    kvNamespaceBindings: [{
        name: "ASSETS_KV",
        namespaceId: fetcherAssetsKv.id,
    }],
    plainTextBindings: [{
        name: "ALLOWED_CATEGORIES",
        text: "map",
    },{
        name: "PUBSUB_TOPIC",
        text: cacheRequests.id
    }],
    secretTextBindings: [{
        name: "SERVICE_ACCOUNT_KEY",
        text: fetcherWorkerKey.privateKey.apply(atob),
    }],
    r2BucketBindings: fetcherAssetsBuckets.map(bucket => ({
        name: bucket.location.apply(region => `R2_BUCKET_${region.toUpperCase()}`),
        bucketName: bucket.name,
    })),
});

const fetcherZone = new cloudflare.Zone("fetcher-zone", {
    accountId: config.require("cloudflareAccountId"),
    zone: "beyondallreason.dev",
    plan: "free",
});

const fetcherWorkerDomain = new cloudflare.WorkerDomain("fetcher-domain", {
    accountId: config.require("cloudflareAccountId"),
    hostname: pulumi.interpolate `files-cdn${pulumi.getStack() === "prod" ? "" : "-" + pulumi.getStack()}.${fetcherZone.zone}`,
    zoneId: fetcherZone.id,
    service: fetcherWorkerScript.name,
});
