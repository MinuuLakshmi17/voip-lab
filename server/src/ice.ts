import { createHmac } from "node:crypto";

/**
 * Time-limited TURN credentials, coturn long-term-credential style
 * (the same scheme coturn's `use-auth-secret` / `static-auth-secret`
 * expects, also known as the TURN REST API):
 *
 *   username = <unix expiry timestamp>
 *   password = base64( HMAC-SHA1( secret, username ) )
 *
 * The shared secret is never sent to the client; only the derived
 * username/password pair is, and it expires after `ttlSeconds`.
 */
export interface TurnCredentials {
  username: string;
  password: string;
  ttlSeconds: number;
  expiresAt: number;
}

export function generateTurnCredentials(
  secret: string,
  ttlSeconds = 3600,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): TurnCredentials {
  const expiresAt = nowSeconds + ttlSeconds;
  const username = String(expiresAt);
  const password = createHmac("sha1", secret).update(username).digest("base64");
  return { username, password, ttlSeconds, expiresAt };
}

export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * ICE server list handed to the browser client. STUN is always included;
 * TURN is included only when a shared secret is configured, with
 * time-limited credentials derived from it.
 */
export function buildIceServers(options: {
  turnSecret?: string;
  turnHost?: string;
  stunUrls?: string[];
  ttlSeconds?: number;
  /** Include the turns: (TLS) URL. Only set this when coturn has a real
   * certificate configured; otherwise browsers reject the TLS endpoint. */
  turnTls?: boolean;
}): IceServerConfig[] {
  const servers: IceServerConfig[] = [
    { urls: options.stunUrls ?? ["stun:stun.l.google.com:19302"] },
  ];
  const host = options.turnHost;
  if (options.turnSecret && host) {
    const creds = generateTurnCredentials(options.turnSecret, options.ttlSeconds);
    const urls = [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`];
    if (options.turnTls) urls.push(`turns:${host}:5349?transport=tcp`);
    servers.push({ urls, username: creds.username, credential: creds.password });
  }
  return servers;
}
