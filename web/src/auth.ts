import { config } from './config';
import { storage } from './storage';

/*
 * PlayHex OAuth, authorization code + PKCE, public client.
 * Only used to get player AI worker keys (scope read:ai-worker-keys),
 * then worker uses its key: access token is not kept.
 */

export type AiWorkerKey = {
    name: string;
    key: string;
    enabled: boolean;
    revokedAt: null | string;
};

const SCOPE = 'openid read:ai-worker-keys';

const redirectUri = (): string => window.location.origin + window.location.pathname;

const randomString = (): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));

    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const sha256 = async (text: string): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));

    return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * Redirects to PlayHex authorization page.
 */
export const login = async (): Promise<void> => {
    const state = randomString();
    const codeVerifier = randomString();

    storage.set('pkce', { state, codeVerifier });

    const url = new URL(config.playhexUrl + '/oidc/auth');
    url.search = new URLSearchParams({
        client_id: config.oauthClientId,
        response_type: 'code',
        redirect_uri: redirectUri(),
        scope: SCOPE,
        state,
        code_challenge: await sha256(codeVerifier),
        code_challenge_method: 'S256',
    }).toString();

    window.location.href = url.toString();
};

/**
 * When coming back from PlayHex authorization page, exchanges code for an access token,
 * then gets player enabled worker keys, and pseudo if PlayHex gives it.
 *
 * @returns null if page is not an authorization callback.
 * @throws {Error} If authorization refused or failed.
 */
export const handleLoginCallback = async (): Promise<null | { keys: AiWorkerKey[], account: null | string }> => {
    const params = new URLSearchParams(window.location.search);

    if (!params.has('code') && !params.has('error')) {
        return null;
    }

    history.replaceState(null, '', redirectUri());

    const pkce = storage.get<{ state: string, codeVerifier: string }>('pkce');
    storage.remove('pkce');

    if (params.has('error')) {
        throw new Error(params.get('error_description') ?? params.get('error') ?? 'Authorization refused');
    }

    if (pkce === null || pkce.state !== params.get('state')) {
        throw new Error('Invalid authorization state');
    }

    const tokenResponse = await fetch(config.playhexUrl + '/oidc/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: params.get('code')!,
            redirect_uri: redirectUri(),
            client_id: config.oauthClientId,
            code_verifier: pkce.codeVerifier,
        }),
    });

    if (!tokenResponse.ok) {
        throw new Error(`Could not get access token: ${await tokenResponse.text()}`);
    }

    const { access_token: accessToken } = await tokenResponse.json() as { access_token: string };

    const keysResponse = await fetch(config.playhexUrl + '/api/player-ai-worker-keys', {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });

    if (!keysResponse.ok) {
        throw new Error(`Could not get worker keys: ${await keysResponse.text()}`);
    }

    const keys = await keysResponse.json() as AiWorkerKey[];

    const account = await fetch(config.playhexUrl + '/oidc/me', { headers: { Authorization: `Bearer ${accessToken}` } })
        .then(async response => response.ok ? (await response.json() as { pseudo?: string }).pseudo ?? null : null)
        .catch(() => null);

    return { keys: keys.filter(key => key.enabled && key.revokedAt === null), account };
};
