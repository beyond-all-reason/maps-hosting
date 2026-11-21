import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as jose from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as lib from "../../lib";
import worker from "../src/index";

const ORIGIN = "https://files-cdn.example.com";
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

async function get(path: string, headers?: Record<string, string>, workerEnv: Env = env): Promise<Response> {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new IncomingRequest(`${ORIGIN}${path}`, { headers }), workerEnv, ctx);
    await waitOnExecutionContext(ctx);
    return response;
}

// All outbound requests from the worker go through this mock, so tests never
// touch the network. Handlers are matched by URL prefix.
type FetchHandler = (req: Request) => Promise<Response> | Response;
let fetchHandlers: Map<string, FetchHandler>;
let fetchedUrls: string[];

beforeEach(async () => {
    fetchHandlers = new Map();
    fetchedUrls = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const req = new Request(input, init);
        fetchedUrls.push(req.url);
        for (const [prefix, handler] of fetchHandlers) {
            if (req.url.startsWith(prefix)) {
                return handler(req);
            }
        }
        throw new Error(`Unexpected fetch to ${req.url}`);
    });

    const contents = "alpha1 map contents\n";
    await env.R2_BUCKET_WEUR.put("ff01234", contents);
    await env.R2_BUCKET_WNAM.put("ff01234", contents);
    await env.R2_BUCKET_APAC.put("ff01234", contents);
    // Ignoring a bunch of required fields for now.
    await env.ASSETS_KV.put("from_name/map/alpha1", JSON.stringify({
        filename: "alpha1.txt",
        springname: "alpha1",
        md5: "ff01234",
        mirrors: ["file/ff01234/alpha1.txt"],
    }));
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("/find", () => {
    it("finds asset stored in KV", async () => {
        const res = await get("/find?category=map&springname=alpha1");
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
        expect(res.headers.get("cache-control")).toContain("max-age=1800");
        const body = await res.json<lib.SpringFilesAsset[]>();
        expect(body[0].filename).toBe("alpha1.txt");
        expect(body[0].mirrors[0]).toBe(`${ORIGIN}/file/ff01234/alpha1.txt`);
        expect(fetchedUrls).toEqual([]);
    });

    it("requires category", async () => {
        expect((await get("/find?springname=map1")).status).toBe(400);
    });

    it("requires springname", async () => {
        expect((await get("/find?category=map")).status).toBe(400);
    });

    it("rejects too long springname", async () => {
        expect((await get(`/find?category=map&springname=${"asd".repeat(40)}`)).status).toBe(400);
    });

    it("rejects unrecognized category without redirecting to springfiles", async () => {
        const res = await get("/find?category=bad&springname=map1");
        expect(res.status).toBe(400);
        expect(res.headers.get("location")).toBeNull();
    });

    it("returns 404 for map missing in KV without asking springfiles or requesting caching", async () => {
        expect((await get("/find?category=map&springname=map1")).status).toBe(404);
        expect(fetchedUrls).toEqual([]);
    });
});

describe("/find with springfiles fallback enabled", () => {
    const fallbackEnv = (extra?: Partial<Env>): Env => ({ ...env, SPRINGFILES_FALLBACK: "true", ...extra });

    it("redirects unrecognized category to springfiles", async () => {
        const res = await get("/find?category=bad&springname=map1", {}, fallbackEnv());
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("https://springfiles.springrts.com/json.php?category=bad&springname=map1");
    });

    it("returns 404 for engine missing in KV without asking springfiles", async () => {
        expect((await get("/find?category=engine_linux64&springname=e1", {}, fallbackEnv())).status).toBe(404);
        expect(fetchedUrls).toEqual([]);
    });

    it("returns 404 when map is not in springfiles either", async () => {
        fetchHandlers.set("https://springfiles.springrts.com/", () => Response.json([]));
        expect((await get("/find?category=map&springname=map1", {}, fallbackEnv())).status).toBe(404);
        expect(fetchedUrls).toEqual(["https://springfiles.springrts.com/json.php?category=map&springname=map1"]);
    });

    it("returns 502 when springfiles fails", async () => {
        fetchHandlers.set("https://springfiles.springrts.com/", () => new Response("oops", { status: 500 }));
        expect((await get("/find?category=map&springname=map1", {}, fallbackEnv())).status).toBe(502);
    });

    it("falls back to springfiles and requests caching via Pub/Sub", async () => {
        const { publicKey, serviceAccountKey } = await generateServiceAccountKey();
        const springname = "Canis River v1.0";
        const springfilesAsset = {
            springname,
            filename: "canis_river_v1.0.sd7",
            md5: "acd611322b4722278a63b76f2bf4cb5a",
            mirrors: ["https://springfiles.springrts.com/files/maps/canis_river_v1.0.sd7"],
        };
        fetchHandlers.set("https://springfiles.springrts.com/json.php", (req) => {
            expect(new URL(req.url).searchParams.get("springname")).toBe(springname);
            return Response.json([springfilesAsset]);
        });
        fetchHandlers.set(serviceAccountKey.token_uri, async (req) => {
            const form = await req.formData();
            expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
            const { payload, protectedHeader } = await jose.jwtVerify(form.get("assertion") as string, publicKey, {
                issuer: serviceAccountKey.client_email,
                audience: serviceAccountKey.token_uri,
            });
            expect(protectedHeader.alg).toBe("RS256");
            expect(payload.scope).toBe("https://www.googleapis.com/auth/cloud-platform");
            return Response.json({ access_token: "test-access-token", token_type: "Bearer", expires_in: 3599 });
        });
        let published: unknown;
        fetchHandlers.set(`https://pubsub.googleapis.com/v1/${env.PUBSUB_TOPIC}:publish`, async (req) => {
            expect(req.method).toBe("POST");
            expect(req.headers.get("authorization")).toBe("Bearer test-access-token");
            published = await req.json();
            return Response.json({ messageIds: ["123"] });
        });

        const res = await get(`/find?category=map&springname=${encodeURIComponent(springname)}`, {},
            fallbackEnv({ SERVICE_ACCOUNT_KEY: JSON.stringify(serviceAccountKey) }));

        expect(res.status).toBe(200);
        const body = await res.json<lib.SpringFilesAsset[]>();
        expect(body[0].md5).toBe(springfilesAsset.md5);
        expect(body[0].mirrors[0]).toBe(springfilesAsset.mirrors[0]);
        expect(published).toEqual({
            messages: [{
                data: btoa(JSON.stringify({ category: "map", springname })),
                attributes: { requestType: "SyncRequest" },
            }],
        });
    });
});

describe("/download", () => {
    it("redirects to the first mirror", async () => {
        const res = await get("/download?category=map&springname=alpha1");
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(`${ORIGIN}/file/ff01234/alpha1.txt`);
    });

    it("rejects unrecognized category", async () => {
        expect((await get("/download?category=bad&springname=map1")).status).toBe(400);
    });

    it("returns 404 for map missing in KV without asking springfiles", async () => {
        expect((await get("/download?category=map&springname=map1")).status).toBe(404);
        expect(fetchedUrls).toEqual([]);
    });
});

describe("/file", () => {
    it("serves the file and then serves it from cache", async () => {
        let res = await get("/file/ff01234/alpha1.txt");
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        expect(res.headers.get("content-disposition")).toBe('attachment; filename="alpha1.txt"');
        expect(res.headers.get("x-fetcher-source")).not.toBe("cache");
        expect(await res.text()).toBe("alpha1 map contents\n");

        res = await get("/file/ff01234/alpha1.txt");
        expect(res.status).toBe(200);
        expect(res.headers.get("x-fetcher-source")).toBe("cache");
        expect(await res.text()).toBe("alpha1 map contents\n");

        res = await get("/file/ff01234/alpha1.txt", { "cache-control": "no-cache" });
        expect(res.status).toBe(200);
        expect(res.headers.get("x-fetcher-source")).not.toBe("cache");
        expect(await res.text()).toBe("alpha1 map contents\n");
    });

    it("returns 404 for missing object", async () => {
        const res = await get("/file/0000/missing.txt", { "cache-control": "no-cache" });
        expect(res.status).toBe(404);
    });

    it("rejects malformed path", async () => {
        expect((await get("/file/ff01234")).status).toBe(400);
    });

    it.for<{ name: string, headers: Record<string, string>, region: string }>([
        { name: "region override apac", headers: { "x-fetcher-region": "apac" }, region: "apac" },
        { name: "region override wnam", headers: { "x-fetcher-region": "wnam" }, region: "wnam" },
        { name: "position in WEUR", headers: { "x-fetcher-lat": "46.5742096", "x-fetcher-lon": "9.2805161" }, region: "weur" },
        { name: "position in WNAM", headers: { "x-fetcher-lat": "-4.3214685", "x-fetcher-lon": "-66.2165546" }, region: "wnam" },
        { name: "position in APAC", headers: { "x-fetcher-lat": "7.2874222", "x-fetcher-lon": "126.0479856" }, region: "apac" },
        { name: "bad position falls back to weur", headers: { "x-fetcher-lat": "asdasd", "x-fetcher-lon": "asdasd" }, region: "weur" },
    ])("picks bucket: $name", async ({ headers, region }) => {
        const res = await get("/file/ff01234/alpha1.txt", { "cache-control": "no-cache", ...headers });
        expect(res.status).toBe(200);
        expect(res.headers.get("x-fetcher-source")).toBe(region);
        expect(await res.text()).toBe("alpha1 map contents\n");
    });
});

describe("routing", () => {
    it("returns 404 for unknown path", async () => {
        expect((await get("/asd")).status).toBe(404);
    });

    it("rejects non-GET methods", async () => {
        const ctx = createExecutionContext();
        const res = await worker.fetch(new IncomingRequest(`${ORIGIN}/find`, { method: "POST", body: "x" }), env, ctx);
        await waitOnExecutionContext(ctx);
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("GET");
    });
});

async function generateServiceAccountKey() {
    const { publicKey, privateKey } = await crypto.subtle.generateKey({
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
    }, true, ["sign", "verify"]) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey) as ArrayBuffer);
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8)).match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
    return {
        publicKey,
        serviceAccountKey: {
            type: "service_account",
            project_id: "test-project",
            private_key_id: "test-key-id",
            private_key: pem,
            client_email: "fetcher@test-project.iam.gserviceaccount.com",
            client_id: "1",
            auth_uri: "https://accounts.google.com/o/oauth2/auth",
            token_uri: "https://oauth2.googleapis.com/token",
            auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
            client_x509_cert_url: "https://www.googleapis.com/robot/v1/metadata/x509/fetcher",
        },
    };
}
