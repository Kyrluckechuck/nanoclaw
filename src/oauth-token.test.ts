import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs before importing the module
const mockFs = {
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
};
vi.mock('fs', () => ({ default: mockFs, ...mockFs }));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock https.request so refreshToken never makes real HTTP calls
const mockRequestResponse = {
  on: vi.fn(),
  statusCode: 200,
};
const mockRequest = {
  on: vi.fn(),
  write: vi.fn(),
  end: vi.fn(),
};
vi.mock('https', () => ({
  request: vi.fn((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
    // Call callback with mock response on next tick
    setTimeout(() => cb(mockRequestResponse), 0);
    return mockRequest;
  }),
}));

// Must re-import fresh for each test to reset module-level cache
let getFreshOAuthToken: typeof import('./oauth-token.js').getFreshOAuthToken;
let hasOAuthCredentials: typeof import('./oauth-token.js').hasOAuthCredentials;

describe('oauth-token', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();

    // Re-mock after resetModules
    vi.doMock('fs', () => ({ default: mockFs, ...mockFs }));
    vi.doMock('./logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    vi.doMock('https', () => ({
      request: vi.fn(
        (_url: string, _opts: unknown, cb: (res: unknown) => void) => {
          setTimeout(() => cb(mockRequestResponse), 0);
          return mockRequest;
        },
      ),
    }));

    const mod = await import('./oauth-token.js');
    getFreshOAuthToken = mod.getFreshOAuthToken;
    hasOAuthCredentials = mod.hasOAuthCredentials;
  });

  describe('hasOAuthCredentials', () => {
    it('returns false when credentials file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);
      expect(hasOAuthCredentials()).toBe(false);
    });

    it('returns false when credentials file has no claudeAiOauth', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({}));
      expect(hasOAuthCredentials()).toBe(false);
    });

    it('returns true when credentials file has valid OAuth token', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'sk-ant-oat01-test',
            refreshToken: 'sk-ant-ort01-test',
            expiresAt: Date.now() + 3600000,
          },
        }),
      );
      expect(hasOAuthCredentials()).toBe(true);
    });

    it('returns false when credentials file is corrupt', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('not-json');
      expect(hasOAuthCredentials()).toBe(false);
    });
  });

  describe('getFreshOAuthToken', () => {
    it('returns null when no credentials file exists', async () => {
      mockFs.existsSync.mockReturnValue(false);
      const token = await getFreshOAuthToken();
      expect(token).toBeNull();
    });

    it('returns cached token when not expired', async () => {
      const futureExpiry = Date.now() + 3600000; // 1 hour from now
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'fresh-token',
            refreshToken: 'refresh-token',
            expiresAt: futureExpiry,
          },
        }),
      );

      // First call reads from file
      const token1 = await getFreshOAuthToken();
      expect(token1).toBe('fresh-token');

      // Second call should use cache (not read file again)
      mockFs.readFileSync.mockClear();
      const token2 = await getFreshOAuthToken();
      expect(token2).toBe('fresh-token');
      expect(mockFs.readFileSync).not.toHaveBeenCalled();
    });

    it('returns existing token as fallback when refresh fails', async () => {
      const expiredTime = Date.now() - 1000; // Already expired
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'expired-token',
            refreshToken: 'refresh-token',
            expiresAt: expiredTime,
          },
        }),
      );

      // Make refresh fail (mock response with no access_token)
      mockRequestResponse.on = vi.fn((event: string, cb: (chunk?: Buffer) => void) => {
        if (event === 'data') {
          cb(Buffer.from(JSON.stringify({ error: 'invalid_grant' })));
        }
        if (event === 'end') {
          cb();
        }
      });

      const token = await getFreshOAuthToken();
      // Should fall back to existing token
      expect(token).toBe('expired-token');
    });
  });
});
