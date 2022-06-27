import * as http from 'http';
import * as lib from '../../lib/index.js';
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

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
    attributes?: {[key: string]: string},
    data?: string,
    messageId: string,
    publishTime: string,
}

async function uploadToR2(filename: string, body: ReadableStream<Uint8Array>) {
    const client = new S3Client({
        region: "auto",
        endpoint: `https://${process.env.CF_ACCOUNT_ID!}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: process.env.CF_R2_ACCESS_KEY_ID!,
            secretAccessKey: process.env.CF_R2_ACCESS_KEY_SECRET!,
        }
    });
    // Would be nice if we had some e2e integrity checks here, but i've not
    // figured out how to do it well currectly with this API when it's a
    // multi part upload.
    const upload = new Upload({
        client,
        params: {
            Bucket: process.env.CF_R2_BUCKET!,
            Key: filename,
            Body: body
        }
    });
    await upload.done();
}

async function cfKVPut(key: string, value: string) {
    const url = `https://api.cloudflare.com/client/v4/accounts`
        + `/${process.env.CF_ACCOUNT_ID!}/storage/kv/namespaces`
        + `/${process.env.CF_KV_NAMESPACE_ID!}/values/${encodeURIComponent(key)}`;
    const response = await fetch(url, {
        method: 'PUT',
        headers: {'Authorization': `Bearer ${process.env.CF_KV_API_TOKEN!}`},
        body: value,
    });
    try {
        if (!response.ok) {
            console.error(await response.json());
            throw lib.httpInternalServerError("Cloudflare set key failed");
        }
    } finally {
        await response.body?.cancel();
    }
}

async function handlePubSub(buffer: Buffer): Promise<HTTPResponse> {
    const msg: PubSubRequest = JSON.parse(buffer.toString('utf8'));
    if (!msg.message.data) {
        throw lib.httpBadRequest('message doesn\'t have data property');
    }
    const dataBuf = Buffer.from(msg.message.data, 'base64');
    const req: lib.SyncRequest = JSON.parse(dataBuf.toString('utf8'));

    console.info(`Handling message ${msg.message.messageId}, fetching ${req.category}/${req.springname}`);
    const asset = await lib.fetchFromSpringFiles(req.category, req.springname);

    // Upload file to R2
    const response = await fetch(asset.mirrors[0]);
    try {
        if (!response.ok) {
            throw lib.httpBadGateway(`Fetch from springfiles failed with ${response.status}`);
        }
        await uploadToR2(asset.md5, response.body!);
    } finally {
        await response.body?.cancel();
    }

    // Put file metadata to KV
    asset.mirrors = [`file/${asset.md5}/${asset.filename}`];
    await cfKVPut(lib.getKVKey(req.category, req.springname), JSON.stringify(asset));

    return new HTTPResponse("ok", 200);
}

function handler(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Array<Buffer> = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
        if (!req.complete) {
            console.error('The connection was terminated before getting all data');
        } else {
            const data = Buffer.concat(chunks);
            handlePubSub(data).then(response => {
                response.writeResponse(res);
            }).catch(e => {
                if (!(e instanceof lib.HTTPError)) {
                    console.error(e);
                    e = lib.httpInternalServerError();
                }
                const response = new HTTPResponse(e.message, e.status);
                response.writeResponse(res);
            });
        }
    });
    req.on('error', (err: Error) => {
        console.error(err);
    });
}

function main() {
    for (const env of ['CF_ACCOUNT_ID',
                       'CF_R2_BUCKET',
                       'CF_R2_ACCESS_KEY_ID',
                       'CF_R2_ACCESS_KEY_SECRET',
                       'CF_KV_NAMESPACE_ID',
                       'CF_KV_API_TOKEN']) {
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
