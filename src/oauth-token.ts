/**
 * OAuth token management for Claude Code credentials.
 *
 * Reads the OAuth access token from ~/.claude/.credentials.json (set by
 * the browser-based `claude auth login` flow). Automatically refreshes
 * the token when it expires using the stored refresh token.
 *
 * Falls back to CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN from .env
 * if the credentials file doesn't exist (e.g., setup-token flow).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { request as httpsRequest } from 'https';

import { logger } from './logger.js';

interface CredentialsFile {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
  };
}

const CREDENTIALS_PATH = path.join(
  os.homedir(),
  '.claude',
  '.credentials.json',
);
const REFRESH_URL = 'https://console.anthropic.com/api/oauth/token';
// Refresh 5 minutes before actual expiry
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

let cachedToken: string | null = null;
let cachedExpiresAt = 0;
let refreshing: Promise<string | null> | null = null;

function readCredentials(): CredentialsFile | null {
  try {
    if (!fs.existsSync(CREDENTIALS_PATH)) return null;
    return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
  } catch (err) {
    logger.warn({ err }, 'Failed to read Claude credentials file');
    return null;
  }
}

function writeCredentials(creds: CredentialsFile): void {
  try {
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));
  } catch (err) {
    logger.warn({ err }, 'Failed to write refreshed credentials');
  }
}

async function refreshToken(refreshTokenStr: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
} | null> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshTokenStr,
    });

    const req = httpsRequest(
      REFRESH_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            if (data.access_token) {
              resolve({
                accessToken: data.access_token,
                refreshToken: data.refresh_token || refreshTokenStr,
                expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
              });
            } else {
              logger.error(
                { response: data },
                'OAuth refresh failed: no access_token in response',
              );
              resolve(null);
            }
          } catch (err) {
            logger.error({ err }, 'Failed to parse OAuth refresh response');
            resolve(null);
          }
        });
      },
    );

    req.on('error', (err) => {
      logger.error({ err }, 'OAuth refresh request failed');
      resolve(null);
    });

    req.write(body);
    req.end();
  });
}

/**
 * Get a fresh OAuth access token.
 * Reads from ~/.claude/.credentials.json, refreshes if expired.
 * Returns null if no credentials are available.
 */
export async function getFreshOAuthToken(): Promise<string | null> {
  // Return cached token if still valid
  if (cachedToken && Date.now() < cachedExpiresAt - EXPIRY_BUFFER_MS) {
    return cachedToken;
  }

  // Serialize concurrent refresh attempts
  if (refreshing) return refreshing;

  refreshing = (async () => {
    try {
      const creds = readCredentials();
      if (!creds?.claudeAiOauth) return null;

      const oauth = creds.claudeAiOauth;

      // Token still valid
      if (Date.now() < oauth.expiresAt - EXPIRY_BUFFER_MS) {
        cachedToken = oauth.accessToken;
        cachedExpiresAt = oauth.expiresAt;
        return cachedToken;
      }

      // Need refresh
      logger.info('OAuth token expired, refreshing...');
      const refreshed = await refreshToken(oauth.refreshToken);
      if (!refreshed) {
        // Refresh failed — return existing token as last resort
        logger.warn('OAuth refresh failed, using existing token');
        cachedToken = oauth.accessToken;
        return cachedToken;
      }

      // Update cached values
      cachedToken = refreshed.accessToken;
      cachedExpiresAt = refreshed.expiresAt;

      // Persist refreshed credentials
      creds.claudeAiOauth.accessToken = refreshed.accessToken;
      creds.claudeAiOauth.refreshToken = refreshed.refreshToken;
      creds.claudeAiOauth.expiresAt = refreshed.expiresAt;
      writeCredentials(creds);

      logger.info('OAuth token refreshed successfully');
      return cachedToken;
    } finally {
      refreshing = null;
    }
  })();

  return refreshing;
}

/**
 * Check if credentials file exists with OAuth tokens.
 */
export function hasOAuthCredentials(): boolean {
  const creds = readCredentials();
  return !!creds?.claudeAiOauth?.accessToken;
}
