import * as jose from 'jose';

interface ServiceAccountKey {
    type: string,
    project_id: string,
    private_key_id: string,
    private_key: string,
    client_email: string,
    client_id: string,
    auth_uri: string,
    token_uri: string,
    auth_provider_x509_cert_url: string,
    client_x509_cert_url: string,
}

interface OAuth2AccessToken {
    access_token: string,
    token_type: string,
    expires_in: number,
}

async function getAuthToken(service_account_key: string): Promise<string> {
    const saKey: ServiceAccountKey = JSON.parse(service_account_key);
    const privKey = await jose.importPKCS8(saKey.private_key, 'RS256');
    const jwt = await new jose.SignJWT({scope: 'https://www.googleapis.com/auth/cloud-platform'})
        .setProtectedHeader({alg: 'RS256', typ: 'JWT'})
        .setAudience(saKey.token_uri)
        .setExpirationTime('5m')
        .setIssuedAt()
        .setIssuer(saKey.client_email)
        .sign(privKey);
    const form = new FormData();
    form.append('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    form.append('assertion', jwt);
    const res = await fetch(saKey.token_uri, {method: 'POST', body: form});
    if (!res.ok) {
        throw new Error(`Getting auth token failed with ${res.status}`);
    }
    const auth_token = await res.json<OAuth2AccessToken>();
    return auth_token.access_token;
}

interface PubSubResult {
    messageIds: Array<string>;
}

export async function publish(service_account_key: string, topic: string, msg: string, attributes: {[key: string]: string}): Promise<string> {
    const message = JSON.stringify({messages: [{data: btoa(msg), attributes}]});
    const token = await getAuthToken(service_account_key);
    const response = await fetch(`https://pubsub.googleapis.com/v1/${topic}:publish`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json; charset=utf-8',
        },
        body: message,
    });
    if (!response.ok) {
        throw new Error(`Push failed with ${response.status}`);
    }
    const result = await response.json<PubSubResult>();
    return result.messageIds[0];
}
