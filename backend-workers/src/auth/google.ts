/**
 * Verifies Google ID tokens like Google.Apis.Auth's `GoogleJsonWebSignature.ValidateAsync` does in the C# API:
 * RS256 signature with Google's published keys, issuer `accounts.google.com` or `https://accounts.google.com`, every
 * audience equal to our OAuth client id, not expired (no tolerance) and not issued in the future (30 s tolerance).
 * Returns null for any invalid token; network failures fetching Google's keys are thrown (HTTP 500), as in C#.
 */
export interface GoogleIdentity {
  /** Google's stable account id (`sub` claim). */
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  /** The Google Workspace domain of the account (`hd` claim), if any. */
  hostedDomain: string | null;
}

export interface GoogleTokenVerifier {
  verify(idToken: string, clientId: string, now: Date): Promise<GoogleIdentity | null>;
}

/** Returns Google's current signing keys (JWKS `keys`). */
export type KeySource = (options: { refresh: boolean }) => Promise<JsonWebKey[]>;

const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const ISSUED_AT_TOLERANCE_MS = 30_000;

export function createGoogleVerifier(keySource: KeySource, log: (reason: string) => void): GoogleTokenVerifier {
  return {
    async verify(idToken, clientId, now) {
      const reject = (reason: string) => {
        log(reason);
        return null;
      };

      const parts = idToken.split('.');
      if (parts.length !== 3) return reject('JWT must consist of Header, Payload, and Signature');
      const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
      const header = decodeJson(headerPart);
      const payload = decodeJson(payloadPart);
      const signature = decodeBase64Url(signaturePart);
      if (!header || !payload || !signature) return reject('JWT is not well-formed');
      if (header.alg !== 'RS256') return reject('JWT algorithm must be RS256');

      let key = await findKey(keySource, header.kid, false);
      key ??= await findKey(keySource, header.kid, true); // Google rotated its keys
      if (!key) return reject("JWT signing key is not one of Google's");

      const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
      const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed);
      if (!valid) return reject('JWT invalid, unable to verify signature');

      if (typeof payload.iss !== 'string' || !ISSUERS.includes(payload.iss)) return reject('JWT issuer incorrect');
      const audiences = typeof payload.aud === 'string' ? [payload.aud] : payload.aud;
      if (
        !Array.isArray(audiences) ||
        audiences.length === 0 ||
        !audiences.every((audience) => audience === clientId)
      ) {
        return reject("JWT contains untrusted 'aud' claim");
      }

      const time = now.getTime();
      if (typeof payload.exp !== 'number' || time > payload.exp * 1000) return reject('JWT has expired');
      if (typeof payload.iat !== 'number' || time + ISSUED_AT_TOLERANCE_MS < payload.iat * 1000) {
        return reject('JWT is not yet valid');
      }

      if (typeof payload.sub !== 'string' || payload.sub === '') return reject('JWT has no subject');

      return {
        subject: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : null,
        emailVerified: payload.email_verified === true || payload.email_verified === 'true',
        name: typeof payload.name === 'string' ? payload.name : null,
        hostedDomain: typeof payload.hd === 'string' ? payload.hd : null,
      };
    },
  };
}

async function findKey(keySource: KeySource, kid: unknown, refresh: boolean): Promise<CryptoKey | null> {
  const jwk = (await keySource({ refresh })).find((k) => (k as { kid?: string }).kid === kid && k.kty === 'RSA');
  if (!jwk) return null;
  return crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}

export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

interface CachedKeys {
  keys: JsonWebKey[];
  expiresAt: number;
  fetchedAt: number;
}

let cache: CachedKeys | null = null;

/**
 * Google's keys from GOOGLE_CERTS_URL, cached in the isolate for the response's max-age (Google sends hours). A forced
 * refresh (unknown key id) is allowed at most once a minute.
 */
export const googleKeySource: KeySource = async ({ refresh }) => {
  const now = Date.now();
  if (cache && now < cache.expiresAt && (!refresh || now - cache.fetchedAt < 60_000)) {
    return cache.keys;
  }

  const response = await fetch(GOOGLE_CERTS_URL);
  if (!response.ok) throw new Error(`Fetching Google's signing keys failed with HTTP ${response.status}.`);
  const body = (await response.json()) as { keys?: JsonWebKey[] };
  const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '')?.[1] ?? 3600);
  cache = { keys: body.keys ?? [], expiresAt: now + maxAge * 1000, fetchedAt: now };
  return cache.keys;
};

function decodeJson(part: string): Record<string, unknown> | null {
  const bytes = decodeBase64Url(part);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function decodeBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}
