/**
 * FoxESS OpenAPI request signing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  READ THIS BEFORE CHANGING ANYTHING HERE
 * ─────────────────────────────────────────────────────────────────────────────
 * The signature is `md5(path + "\r\n" + token + "\r\n" + timestamp)`, where the separator is the
 * LITERAL four-character sequence backslash-r-backslash-n — NOT the CR and LF control characters.
 *
 * The official documentation writes the rule as `url + "\r\n" + token + "\r\n" + timestamp`, which
 * reads like CRLF. It is not. The reference Python implementation gives it away by using a *raw*
 * f-string, in which backslashes stay literal:
 *
 *     signature = fr'{path}\r\n{token}\r\n{timestamp}'
 *
 * `macxq/foxess-ha`, which works in production, does the same. Using real CRLF returns
 * `40256 … illegal signature` on every request.
 *
 * `test/sign.test.ts` pins this with a golden vector and asserts the CRLF variant produces a
 * different digest. If that test ever starts failing, fix the caller — not this file.
 */

import { createHash } from 'node:crypto';

/** The literal separator: backslash, 'r', backslash, 'n'. Four characters, no control codes. */
export const SEPARATOR = '\\r\\n';

export interface SignedHeaders extends Record<string, string> {
  token: string;
  timestamp: string;
  signature: string;
  lang: string;
  'Content-Type': string;
  'User-Agent': string;
}

/**
 * FoxESS rejects some default HTTP client user-agents outright, so we send a browser string. This
 * is the exact value from the official sample.
 */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/117.0.0.0 Safari/537.36';

/** Lowercase hex md5, as the API expects. */
export function md5Hex(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex');
}

/**
 * Build the string that gets hashed.
 *
 * `path` must be the request path ONLY — no origin, no query string. `/op/v0/device/detail?sn=X`
 * signs as `/op/v0/device/detail`, even though the query is still sent on the wire.
 */
export function signatureBase(path: string, token: string, timestamp: number | string): string {
  return `${path}${SEPARATOR}${token}${SEPARATOR}${timestamp}`;
}

export function signature(path: string, token: string, timestamp: number | string): string {
  return md5Hex(signatureBase(path, token, timestamp));
}

/**
 * Strip any origin and query string from a URL or path, yielding the value to sign.
 *
 * Signing the query string is the second most common way to get `40256`, so callers hand us
 * whatever they have and this normalises it.
 */
export function signablePath(pathOrUrl: string): string {
  const withoutOrigin = pathOrUrl.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
  const cut = withoutOrigin.search(/[?#]/);
  const path = cut === -1 ? withoutOrigin : withoutOrigin.slice(0, cut);
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * Full header set for a signed request.
 *
 * `timestamp` is milliseconds since the epoch — seconds are rejected.
 */
export function signHeaders(
  pathOrUrl: string,
  token: string,
  opts: { lang?: string; now?: number } = {},
): SignedHeaders {
  const path = signablePath(pathOrUrl);
  const timestamp = opts.now ?? Date.now();

  return {
    token,
    timestamp: String(timestamp),
    signature: signature(path, token, timestamp),
    lang: opts.lang ?? 'en',
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
  };
}
