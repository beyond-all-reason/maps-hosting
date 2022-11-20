import * as cloudflare from "@pulumi/cloudflare";
import * as docker from "@pulumi/docker";
import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

const region = "europe-west1";

const cacher = new gcp.serviceaccount.Account("cacher", {
    accountId: "cacher",
    displayName: "cacher",
}, {protect: true});

const cacherInvoker = new gcp.serviceaccount.Account("cacher-invoker", {
    accountId: "cacher-invoker",
    displayName: "cacher-invoker",
}, {protect: true});

const fetcherWorker = new gcp.serviceaccount.Account("fetcher-worker", {
    accountId: "fetcher-worker",
    description: "CloudFlare fetcher worker script",
    displayName: "Fetcher Worker",
}, {protect: true});

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
    name: "springfiles-upload-8734",
    publicAccessPrevention: "enforced",
    uniformBucketLevelAccess: true,
}, {protect: true});

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

const mainImagesRepo = new gcp.artifactregistry.Repository("main-images-repo", {
    format: "docker",
    location: region,
    repositoryId: "main",
}, {protect: true});

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
});

const cacherRegistryImage = docker.getRegistryImageOutput({
    name: pulumi.interpolate `${mainRepoRegistryAddress}/${mainImagesRepo.project}/${mainImagesRepo.repositoryId}/cacher:latest`,
}, {provider: dockerProvider});

const cfKvApiTokenSecret = new gcp.secretmanager.Secret("cloudflare-kv-api-token-secret", {
    replication: {
        userManaged: {
            replicas: [{
                location: region,
            }],
        },
    },
    secretId: "cloudflare-kv-api-token",
}, {protect: true});

const cacherCfKvApiTokenSecretAccess = new gcp.secretmanager.SecretIamMember("cloudflare-kv-api-token-secret-cacher-access", {
    secretId: cfKvApiTokenSecret.secretId,
    role: "roles/secretmanager.secretAccessor",
    member: pulumi.interpolate `serviceAccount:${cacher.email}`,
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
}, {protect: true});

const cacherR2AccessKeyAccess = new gcp.secretmanager.SecretIamMember("cloudflare-r2-access-key-secret-cacher-access", {
    secretId: cfKvApiTokenSecret.secretId,
    role: "roles/secretmanager.secretAccessor",
    member: pulumi.interpolate `serviceAccount:${cacher.email}`,
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
        },
        spec: {
            containerConcurrency: 2,
            containers: [{
                envs: [
                    {
                        name: "CF_ACCOUNT_ID",
                        value: "fe051a5c7e7c0f6e83deae67de700680",
                    },
                    {
                        name: "CF_KV_API_TOKEN",
                        valueFrom: {
                            secretKeyRef: {
                                key: "latest",
                                name: cfKvApiTokenSecret.secretId,
                            },
                        },
                    },
                    {
                        name: "CF_KV_NAMESPACE_ID",
                        value: "87f5451fe6a54c1f87cce9b6ededb1d1",
                    },
                    {
                        name: "CF_R2_ACCESS_KEY_ID",
                        value: "f9b1e9fae699e35f5e3b1d228d8f7b1e",
                    },
                    {
                        name: "CF_R2_ACCESS_KEY_SECRET",
                        valueFrom: {
                            secretKeyRef: {
                                key: "latest",
                                name: cfR2AccessKeySecret.secretId,
                            },
                        },
                    },
                    {
                        name: "CF_R2_BUCKET",
                        value: "p2004a-springfiles",
                    },
                ],
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
}, {
    protect: false,
    dependsOn: [cacherCfKvApiTokenSecretAccess, cacherR2AccessKeyAccess],
});

const cacherServiceInvoker = new gcp.cloudrun.IamMember("cacher-service-invoker-access", {
    location: region,
    service: cacherService.name,
    role: "roles/run.invoker",
    member: pulumi.interpolate `serviceAccount:${cacherInvoker.email}`,
});

const cacheRequests = new gcp.pubsub.Topic("cache-requests", {
    name: "cache-requests",
}, {protect: true});

const cacheRequestsPolicy = new gcp.pubsub.TopicIAMPolicy("cache-requests-policy", {
    policyData: gcp.organizations.getIAMPolicyOutput({
        bindings: [{
            role: "roles/pubsub.publisher",
            members: [pulumi.interpolate `serviceAccount:${fetcherWorker.email}`]
        }]
    }).apply(p => p.policyData),
    topic: cacheRequests.id
}, {protect: true});

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
}, {protect: true});

const uploadRequests = new gcp.pubsub.Topic("upload-requests", {
    name: "upload-requests",
}, {protect: true});

const gcsAccount = gcp.storage.getProjectServiceAccountOutput({});

const uploadRequestsPolicy = new gcp.pubsub.TopicIAMPolicy("upload-requests-policy", {
    policyData: gcp.organizations.getIAMPolicyOutput({
        bindings: [{
            role: "roles/pubsub.publisher",
            members: [pulumi.interpolate `serviceAccount:${gcsAccount.emailAddress}`]
        }]
    }).apply(p => p.policyData),
    topic: uploadRequests.id,
}, {protect: true});

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
}, {protect: true});

const uploadBucketNotification = new gcp.storage.Notification("upload-bucket-notification", {
    bucket: uploadBucket.name,
    eventTypes: ["OBJECT_FINALIZE"],
    payloadFormat: "JSON_API_V1",
    topic: uploadRequests.id,
}, {
    protect: true,
    dependsOn: [uploadRequestsPolicy],
});
