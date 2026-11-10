import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/**
 * Tests run inside the Workers runtime (workerd, via Miniflare) against a disposable PostgreSQL started by
 * test/global-setup.ts. The settings below replace .dev.vars; they are test values, not secrets.
 */
export default defineConfig({
  plugins: [
    cloudflareTest(({ inject }) => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          ENVIRONMENT: 'development',
          DATABASE_URL: inject('databaseUrl'),
          // Tests only: the schema owner, for seeding and assertions (test/helpers.ts `withDb`). Not a Worker setting.
          OWNER_DATABASE_URL: inject('ownerDatabaseUrl'),
          SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789',
          GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
          GOOGLE_HOSTED_DOMAIN: 'company.example',
          TRAINEE_SIGN_IN_LINK_BASE_URL: 'http://localhost:4200',
          CORS_ALLOWED_ORIGINS: 'http://localhost:4200',
          EMAIL_PROVIDER: '',
          // .dev.vars is read too: never let a developer's real SMTP credentials reach the tests.
          SMTP_USER: '',
          SMTP_APP_PASSWORD: '',
          // Event e-mails stay off unless a test enables them for its own API (test/event-emails.test.ts).
          EVENT_EMAILS: 'disabled',
        },
      },
    })),
  ],
  test: {
    globalSetup: ['./test/global-setup.ts'],
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
