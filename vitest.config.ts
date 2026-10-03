import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            DEV_USER_EMAIL: 'dev@example.com',
            // MCP の認可（Access for SaaS）の設定。テストでは、これらの URL への通信を差し替える
            ACCESS_CLIENT_ID: 'test-access-client',
            ACCESS_CLIENT_SECRET: 'test-access-secret',
            ACCESS_TOKEN_URL: 'https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/test/token',
            ACCESS_AUTHORIZATION_URL:
              'https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/test/authorization',
            ACCESS_JWKS_URL: 'https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/test/jwks',
            COOKIE_ENCRYPTION_KEY: 'test-cookie-key-0123456789abcdef0123456789abcdef',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
    },
  };
});
