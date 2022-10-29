const SPRING_FILES_SEARCH = 'https://springfiles.springrts.com/json.php';

export interface SpringFilesAsset {
    name?: string,
    filename: string,
    path: string,
    md5: string,
    sdp?: string,
    version?: string,
    category: string,
    size: number,
    timestamp: string,
    mirrors: Array<string>,
    tags: Array<string>,
    springname: string,
}

export interface SyncRequest {
    category: string,
    springname: string,
}

// Helpers to easily return proper HTTP errors.
export class HTTPError extends Error {
    status: number;

    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

export const httpBadRequest = (msg: string = 'Bad Request') => new HTTPError(msg, 400);
export const httpInternalServerError = (msg: string = 'Internal Server Error') => new HTTPError(msg, 500);
export const httpNotImplemented = (msg: string = 'Not Implemented') => new HTTPError(msg, 501);
export const httpBadGateway = (msg: string = 'Bad Gateway') => new HTTPError(msg, 502);
export const httpNotFound = (msg: string = 'Not Found') => new HTTPError(msg, 404);

export async function fetchFromSpringFiles(category: string, springname: string): Promise<SpringFilesAsset> {
    const url = new URL(SPRING_FILES_SEARCH);
    url.searchParams.set('category', category);
    url.searchParams.set('springname', springname);
    const response = await fetch(url.toString());
    if (!response.ok) {
        throw httpBadGateway(`Fetch from springfiles failed with ${response.status}`);
    }
    // We assume that resulting JSON is correct without verification.
    let result: Array<SpringFilesAsset>;
    try {
        result = await response.json();
    } catch (e) {
        throw httpBadGateway('Springfiles didn\'t return correct json');
    }
    if (result.length == 0) {
        throw httpNotFound('File not found in springfiles');
    } else if (result.length > 1) {
        throw httpBadRequest('Query returned multiple results from springfiles');
    }
    if (result[0].springname != springname) {
        throw httpBadRequest('Non-deterministic springname requested');
    }
    return result[0];
}

export function getKVKey(category: string, springname: string) {
    return `from_name/${category}/${springname}`;
}
