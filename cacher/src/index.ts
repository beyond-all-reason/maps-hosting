import * as child_process from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as lib from '../../lib/index.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as stream from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as util from 'node:util';
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { AbortController as AWSAbortController } from "@smithy/abort-controller";
import { Storage as GCS } from "@google-cloud/storage";
import {Ajv, JSONSchemaType} from "ajv";

const execFile = util.promisify(child_process.execFile);

class HTTPResponse {
    body: string
    statusCode: number

    constructor(body: string, statusCode: number = 200) {
        this.body = body;
        this.statusCode = statusCode;
    }

    writeResponse(res: http.ServerResponse) {
        res.statusCode = this.statusCode;
        res.write(this.body);
        res.end();
    }
}

interface PubSubRequest {
    message: PubSubMessage,
    subscription: string,
}

interface PubSubMessage {
    attributes: { [key: string]: string } | null,
    data: string | null,
    messageId: string,
    publishTime: string,
}

// https://cloud.google.com/storage/docs/json_api/v1/objects#resource-representations
// Minimal set of properties we need
interface GCSObjectResource {
    bucket: string,
    name: string,
}

const pubSubRequestSchema: JSONSchemaType<PubSubRequest> = {
    type: 'object',
    properties: {
        message: {
            type: 'object',
            properties: {
                attributes: {
                    type: 'object',
                    additionalProperties: { type: 'string' },
                    required: []
                },
                data: { type: 'string' },
                messageId: { type: 'string' },
                publishTime: { type: 'string' },
            },
            required: ['messageId', 'publishTime'],
            additionalProperties: true,
        },
        subscription: { type: 'string' }
    },
    required: ['message', 'subscription'],
    additionalProperties: true,
};

const gcsObjectResourceSchema: JSONSchemaType<GCSObjectResource> = {
    type: 'object',
    properties: {
        bucket: { type: 'string' },
        name: { type: 'string' },
    },
    required: ['bucket', 'name'],
    additionalProperties: true,
};

const syncRequestSchema: JSONSchemaType<lib.SyncRequest> = {
    oneOf: [
        {
            type: 'object',
            properties: {
                category: { const: 'map', type: 'string' },
                springname: { type: 'string' },
            },
            required: ['category', 'springname']
        },
        {
            type: 'object',
            properties: {
                category: { const: 'engine', type: 'string' },
                windows64: {
                    type: 'object',
                    properties: { 'url': { type: 'string' } },
                    required: ['url']
                },
                linux64: {
                    type: 'object',
                    properties: { 'url': { type: 'string' } },
                    required: ['url']
                }
            },
            required: ['category', 'linux64', 'windows64']
        }
    ],
};

const ajv = new Ajv();
const parsePubSubRequest = ajv.compile(pubSubRequestSchema);
const parseSyncRequest = ajv.compile(syncRequestSchema);
const parseGCSObjectResource = ajv.compile(gcsObjectResourceSchema);

async function uploadToR2(opts: {
    bucket: string,
    filename: string,
    srcPath: string,
    abortController: AWSAbortController,
}) {
    const client = new S3Client({
        region: "auto",
        endpoint: `https://${process.env.CF_ACCOUNT_ID!}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: process.env.CF_R2_ACCESS_KEY_ID!,
            secretAccessKey: process.env.CF_R2_ACCESS_KEY_SECRET!,
        }
    });
    const handle = await fs.open(opts.srcPath);
    try {
        const readStream = stream.Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>;

        // Would be nice if we had some e2e integrity checks here, but i've not
        // figured out how to do it well currectly with this API when it's a
        // multi part upload.
        const upload = new Upload({
            client,
            params: {
                Bucket: opts.bucket,
                Key: opts.filename,
                Body: readStream
            },
            abortController: opts.abortController,
        });
        await upload.done();
    } finally {
        await handle.close();
    }
}

async function cfKVCall(method: string, key: string, value?: string, o?: {signal?: AbortSignal}): Promise<Response> {
    const url = `https://api.cloudflare.com/client/v4/accounts`
        + `/${process.env.CF_ACCOUNT_ID!}/storage/kv/namespaces`
        + `/${process.env.CF_KV_NAMESPACE_ID!}/values/${encodeURIComponent(key)}`;
    const response = await fetch(url, {
        method,
        headers: { 'Authorization': `Bearer ${process.env.CF_KV_API_TOKEN!}` },
        body: value,
        signal: o?.signal
    });
    return response;
}

async function cfKVPut(key: string, value: string, o?: {signal?: AbortSignal}) {
    const response = await cfKVCall('PUT', key, value, {signal: o?.signal});
    try {
        if (!response.ok) {
            console.error(await response.json());
            throw lib.httpInternalServerError(`Cloudflare key put failed`);
        }
    } finally {
        await response.body?.cancel();
    }
}

async function cfKVGet(key: string, o?: {signal?: AbortSignal}): Promise<string | null> {
    const resp = await cfKVCall('GET', key, undefined, {signal: o?.signal});
    if (resp.status == 404) {
        await resp.body?.cancel();
        return null;
    } else if (!resp.ok) {
        console.error(await resp.json());
        await resp.body?.cancel();
        throw lib.httpInternalServerError(`Cloudflare key GET failed`);
    }
    return await resp.text();
}

async function saveToCDN(asset: lib.SpringFilesAsset, path: string, opts?: {cacheFile?: boolean, signal?: AbortSignal}) {
    const o = Object.assign({
        cacheFile: true
    }, opts);

    // Let's filter down properties only to the ones we need.
    const baseAsset: lib.SpringFilesAsset = {
        filename: asset.filename,
        springname: asset.springname,
        md5: asset.md5,
        category: asset.category,
        version: asset.version,
        path: asset.path,
        tags: [],
        size: asset.size,
        timestamp: asset.timestamp,
        mirrors: o.cacheFile ? [`file/${asset.md5}/${asset.filename}`] : asset.mirrors,
    };
    const key = lib.getKVKey(asset.category, asset.springname);

    // Check if we already have this file in R2
    if (await cfKVGet(key, {signal: o.signal}) != null) {
        console.log(`Already have ${asset.springname} in KV, skipping`);
        return;
    }

    if (o.cacheFile) {
        const abortController = new AWSAbortController();
        o.signal?.addEventListener('abort', () => abortController.abort());
        try {
            await Promise.all(process.env.CF_R2_BUCKETS!
                .split(',')
                .map(bucket => uploadToR2({
                    bucket,
                    filename: asset.md5,
                    srcPath: path,
                    abortController,
                })));
        } catch (e) {
            abortController.abort();
            throw e;
        }
    }
    await cfKVPut(key, JSON.stringify(baseAsset), {signal: o.signal});
    console.log(`Upload of ${asset.springname} done`);
    console.log(JSON.stringify(baseAsset));
}

async function downloadFile(url: URL, filePath: string, opts?: {signal?: AbortSignal}) {
    const response = await fetch(url, {signal: opts?.signal});
    try {
        if (!response.ok) {
            throw lib.httpBadGateway(`Fetch of file failed with ${response.status}`);
        }
        const handle = await fs.open(filePath, 'w');
        try {
            const writeStream = stream.Writable.toWeb(handle.createWriteStream()) as WritableStream<Uint8Array>;
            await response.body!.pipeTo(writeStream);
        } finally {
            await handle.close();
        }
    } finally {
        await response.body?.cancel();
    }
}

async function handleMapSyncRequest(req: Extract<lib.SyncRequest, {category: 'map'}>, o?: {signal?: AbortSignal}) {
    console.info(`fetching ${req.category}/${req.springname}`);
    const asset = await lib.fetchFromSpringFiles(req.category, req.springname, {signal: o?.signal});

    // Upload file to R2
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'map-'));
    try {
        const mapPath = path.join(tmpDir, 'map.sd7');
        await downloadFile(new URL(asset.mirrors[0]), mapPath, {signal: o?.signal});
        await saveToCDN(asset, mapPath, {signal: o?.signal});
    } finally {
        await fs.rm(tmpDir, { recursive: true });
    }
}

async function fileMd5(path: string, o?: {signal?: AbortSignal}): Promise<string> {
    let handle: fs.FileHandle | undefined;
    try {
        handle = await fs.open(path);
        const readS = handle.createReadStream();
        const md5 = crypto.createHash('md5');
        await pipeline([readS, md5], {signal: o?.signal});
        return md5.digest('hex').toLowerCase();
    } finally {
        await handle?.close();
    }
}

// Based on implementation in upq.
function getNormalizedFileName(springname: string, mapPath: string): string {
    const ext = path.extname(mapPath);
    const name = springname.toLowerCase().replaceAll(/[^abcdefghijklmnopqrstuvwxyz_.01234567890-]/g, "_");
    return `${name}${ext}`.substring(0, 255);
}

async function getSpringName(mapPath: string, opts?: {signal?: AbortSignal}): Promise<string> {
    const { stdout } = await execFile(process.env.PYSMF_PATH!, [mapPath], { timeout: 60 * 1000, signal: opts?.signal });
    return JSON.parse(stdout)['springname'];
}

async function extract7zArchive(archive: string, dest: string, opts?: {signal?: AbortSignal}): Promise<void> {
    await execFile('7z', ['x', archive, '-y', `-o${dest}`], { timeout: 60 * 1000, signal: opts?.signal });
}

async function getEngineVersion(archive: string, opts?: {signal?: AbortSignal}): Promise<string> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-extract-'));
    try {
        await extract7zArchive(archive, tmpDir, {signal: opts?.signal});
        const { stdout } = await execFile(path.join(tmpDir, 'spring-dedicated'), ['-version'], { timeout: 2 * 1000, signal: opts?.signal });
        const m = /.* version (?<version>.*) \(Dedicated\)/.exec(stdout.trim());
        if (!m) {
            throw lib.httpBadRequest(`The engine version string doesn't match expected pattern`);
        }
        return m.groups!.version;
    } finally {
        await fs.rm(tmpDir, { recursive: true });
    }
}

async function handleEngineUpload(req: Extract<lib.SyncRequest, {category: 'engine'}>, o?: {signal?: AbortSignal}) {
    const linux64url = new URL(req.linux64.url);
    const windows64url = new URL(req.windows64.url);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-upload-'));
    const ac = new AbortController();
    o?.signal?.addEventListener('abort', () => ac.abort());
    try {
        const linuxArchive = path.join(tmpDir, 'engine-linux64.7z');
        const windowsArchive = path.join(tmpDir, 'engine-windows64.7z');

        await Promise.all([
            downloadFile(linux64url, linuxArchive, {signal: ac.signal}),
            downloadFile(windows64url, windowsArchive, {signal: ac.signal}),
        ])
        const version = await getEngineVersion(linuxArchive, {signal: ac.signal});
        for (const [category, archive, url] of [
            ['engine_linux64', linuxArchive, linux64url] as const,
            ['engine_windows64', windowsArchive, windows64url] as const,
        ]) {
            const asset: lib.SpringFilesAsset = {
                springname: version,
                category,
                path: "engine",
                tags: [],
                version: version,
                filename: path.basename(url.pathname),
                md5: await fileMd5(archive),
                size: (await fs.stat(archive)).size,
                timestamp: new Date().toISOString().replace('Z', ''),
                mirrors: [url.href],
            };
            await saveToCDN(asset, archive, { cacheFile: false, signal: ac.signal });
        }
    } catch (e) {
        ac.abort();
        throw e;
    } finally {
        await fs.rm(tmpDir, { recursive: true });
    }
}

function handleSyncRequest(req: lib.SyncRequest, o?: {signal?: AbortSignal}): Promise<void> {
    console.log(`Sync request: ${JSON.stringify(req)}`);
    switch (req.category) {
        case 'map': return handleMapSyncRequest(req, {signal: o?.signal});
        case 'engine': return handleEngineUpload(req, {signal: o?.signal});
    }
}

async function handleUploadRequest(obj: GCSObjectResource, o?: {signal?: AbortSignal}) {
    console.log(`Event: ${obj.name} got uploaded to ${obj.bucket} bucket`);
    const storage = new GCS();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'map-'));
    const mapPath = path.join(tmpDir, obj.name);
    try {
        // TODO: no signal for download
        await storage.bucket(obj.bucket).file(obj.name).download({ destination: mapPath });
        const springname = await getSpringName(mapPath, {signal: o?.signal});
        const asset: lib.SpringFilesAsset = {
            springname,
            category: "map",
            path: "maps",
            tags: [],
            filename: getNormalizedFileName(springname, mapPath),
            md5: await fileMd5(mapPath),
            size: (await fs.stat(mapPath)).size,
            timestamp: new Date().toISOString().replace('Z', ''),
            mirrors: [],
        };
        await saveToCDN(asset, mapPath, {signal: o?.signal});
    } finally {
        await fs.rm(tmpDir, { recursive: true });
    }
}

async function handlePubSub(buffer: Buffer, url: URL, o?: {signal?: AbortSignal}): Promise<HTTPResponse> {
    const msgUnknown = JSON.parse(buffer.toString('utf8')) as unknown;
    if (!parsePubSubRequest(msgUnknown)) {
        throw lib.httpBadRequest(`Pubsub request doesn't match required schema: ${ajv.errorsText(parsePubSubRequest.errors)}`);
    }
    const msg: PubSubRequest = msgUnknown;
    if (!msg.message.data) {
        throw lib.httpBadRequest('message doesn\'t have data property');
    }
    const dataBuf = Buffer.from(msg.message.data, 'base64');
    const parsedData = JSON.parse(dataBuf.toString('utf8')) as unknown;

    switch (url.pathname) {
        case "/cache":
            if (!parseSyncRequest(parsedData)) {
                throw lib.httpBadRequest(`Sync request doesn't match schema: ${ajv.errorsText(parseSyncRequest.errors)}`);
            }
            if (!msg.message.attributes ||
                msg.message.attributes["requestType"] != "SyncRequest") {
                throw lib.httpBadRequest("expected requestType=SyncRequest attribute");
            }
            await handleSyncRequest(parsedData, {signal: o?.signal});
            break;
        case "/upload":
            if (!msg.message.attributes ||
                msg.message.attributes["eventType"] != "OBJECT_FINALIZE" ||
                msg.message.attributes["payloadFormat"] != "JSON_API_V1") {
                throw lib.httpBadRequest("expected OBJECT_FINALIZE with JSON_API_V1 payload");
            }
            if (!parseGCSObjectResource(parsedData)) {
                throw lib.httpBadRequest(`Bad gcs object resource shape, not matching schema: ${ajv.errorsText(parseGCSObjectResource.errors)}`);
            }
            await handleUploadRequest(parsedData, {signal: o?.signal});
            break;
        default:
            throw lib.httpNotFound("not defined handling for requested endpoint");
    }
    return new HTTPResponse("ok", 200);
}

function handler(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Array<Buffer> = [];
    const ac = new AbortController();
    let done = false;
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
        if (!req.complete) {
            console.error('The connection was terminated before getting all data');
        } else {
            const url = new URL(req.url!, `http://${req.headers.host}`);
            const data = Buffer.concat(chunks);
            handlePubSub(data, url, {signal: ac.signal}).then(response => {
                response.writeResponse(res);
                done = true;
            }).catch(e => {
                if (!(e instanceof lib.HTTPError)) {
                    e = lib.httpInternalServerError();
                }
                console.error(e);
                const response = new HTTPResponse(e.message, e.status);
                response.writeResponse(res);
                done = true;
            });
        }
    });
    req.socket.on('close', () => {
        if (!done) {
            console.warn('client closed before request done, aborting processing');
            ac.abort();
        }
    });
    req.on('error', (err: Error) => {
        console.error(err);
    });
}

function main() {
    for (const env of [
        'CF_ACCOUNT_ID',
        'CF_R2_BUCKETS',
        'CF_R2_ACCESS_KEY_ID',
        'CF_R2_ACCESS_KEY_SECRET',
        'CF_KV_NAMESPACE_ID',
        'CF_KV_API_TOKEN',
        'PYSMF_PATH'
    ]) {
        if (!process.env[env]) {
            throw new Error(`Required environment variable ${env} not set`);
        }
    }

    let port = 8080;
    if (process.env.PORT) {
        port = parseInt(process.env.PORT);
    } else {
        console.log(`No PORT env varaible set, listening on default ${port}`);
    }
    http.createServer(handler)
        .listen(process.env.PORT ? parseInt(process.env.PORT) : 8080);
}

main();
