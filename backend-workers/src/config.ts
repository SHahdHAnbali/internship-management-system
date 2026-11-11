import { ConfigurationError } from './domain/errors';

/**
 * Worker bindings. Non-secret settings are `vars` in wrangler.jsonc; secrets are set with `wrangler secret put`
 * (production) or `.dev.vars` (local development, git-ignored). See README.md.
 */
export interface Bindings {
  /** `development` enables the e-mail log provider and non-Secure cookies over plain HTTP. Anything else is production. */
  ENVIRONMENT?: string;
  /** Secret. PostgreSQL URL; production must use `sslmode=verify-full`. Ignored when HYPERDRIVE is bound. */
  DATABASE_URL?: string;
  /** Optional Hyperdrive binding in front of Neon (connection pooling); takes precedence over DATABASE_URL. */
  HYPERDRIVE?: Hyperdrive;
  /** Secret. At least 32 random bytes (base64); encrypts and authenticates the session cookie. */
  SESSION_SECRET?: string;
  /** Secret, optional. The previous SESSION_SECRET during a rotation: still accepted for reading cookies. */
  SESSION_SECRET_PREVIOUS?: string;
  GOOGLE_CLIENT_ID?: string;
  /** The staff Google Workspace domains, comma-separated (e.g. `stu.najah.edu,progineer.net`). Empty: staff sign-in off. */
  GOOGLE_HOSTED_DOMAIN?: string;
  TRAINEE_CODE_LIFETIME_MINUTES?: string;
  TRAINEE_SIGN_IN_LINK_BASE_URL?: string;
  /** Minutes without activity after which a session ends (default 10080 = 7 days). */
  SESSION_IDLE_TIMEOUT_MINUTES?: string;
  /** Minutes after sign-in at which a session ends however active it is (default 43200 = 30 days). */
  SESSION_ABSOLUTE_LIFETIME_MINUTES?: string;
  /** Comma-separated origins allowed to call the API with credentials (CORS). Empty: same origin only. */
  CORS_ALLOWED_ORIGINS?: string;
  /**
   * `log` (development only) writes e-mails to the console; `smtp` sends them through an SMTP server such as Gmail
   * (SMTP_* below). Empty: no provider, sign-in e-mails fail with 503.
   */
  EMAIL_PROVIDER?: string;
  /** SMTP server for EMAIL_PROVIDER=smtp (default `smtp.gmail.com`). */
  SMTP_HOST?: string;
  /** SMTP port for EMAIL_PROVIDER=smtp: 465 only (TLS from the first byte; default 465). */
  SMTP_PORT?: string;
  /** The SMTP account, also the sender address (for Gmail, the Gmail address the App Password belongs to). */
  SMTP_USER?: string;
  /** Secret. The SMTP password; for Gmail an App Password (spaces are ignored). */
  SMTP_APP_PASSWORD?: string;
  /**
   * Event e-mails of PDF §7 (AD-59, AD-61): `enabled` turns them on; `disabled`, empty or absent keeps them off (the
   * code default; wrangler.jsonc sets `enabled` for production since 2026-11-11, and the tests set `disabled`). Sign-in
   * e-mails do not depend on it.
   */
  EVENT_EMAILS?: string;
  /** Private R2 bucket for application attachments (CVs, university letters). */
  FILES?: R2Bucket;
  /** Workers Rate Limiting binding for the trainee sign-in endpoints (limit and period are set in wrangler.jsonc). */
  TRAINEE_RATE_LIMITER?: RateLimit;
}

export interface Settings {
  isDevelopment: boolean;
  databaseUrl: string;
  sessionSecrets: string[];
  google: { clientId: string; hostedDomains: string[]; isConfigured: boolean };
  trainee: { codeLifetimeMinutes: number; signInLinkBaseUrl: string };
  sessionIdleTimeoutMinutes: number;
  sessionAbsoluteLifetimeMinutes: number;
  corsAllowedOrigins: string[];
  emailProvider: 'log' | 'smtp' | 'none';
  /** Set when emailProvider is `smtp`. */
  smtp: SmtpSettings | null;
  /** Whether event e-mails are sent (EVENT_EMAILS=enabled). Off by default. */
  eventEmails: boolean;
}

export interface SmtpSettings {
  host: string;
  port: 465;
  user: string;
  password: string;
}

const MIN_SESSION_SECRET_LENGTH = 32;

/** Reads and validates the configuration. Throws ConfigurationError (HTTP 500, logged) when it is unusable. */
export function loadSettings(env: Bindings): Settings {
  const isDevelopment = env.ENVIRONMENT?.trim().toLowerCase() === 'development';
  const databaseUrl = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new ConfigurationError('DATABASE_URL is not configured (or bind HYPERDRIVE). See backend-workers/README.md.');
  }

  if (!isDevelopment && !env.HYPERDRIVE && !/[?&]sslmode=verify-full(&|$)/i.test(databaseUrl)) {
    throw new ConfigurationError('DATABASE_URL must use sslmode=verify-full outside development.');
  }

  const sessionSecrets = [env.SESSION_SECRET, env.SESSION_SECRET_PREVIOUS]
    .map((secret) => secret?.trim() ?? '')
    .filter((secret) => secret.length > 0);
  if ((env.SESSION_SECRET?.trim().length ?? 0) < MIN_SESSION_SECRET_LENGTH) {
    throw new ConfigurationError(`SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters.`);
  }

  const clientId = env.GOOGLE_CLIENT_ID?.trim() ?? '';
  const hostedDomains = staffDomains(env.GOOGLE_HOSTED_DOMAIN);
  const emailProvider = env.EMAIL_PROVIDER?.trim().toLowerCase() ?? '';
  if (emailProvider !== '' && emailProvider !== 'log' && emailProvider !== 'smtp') {
    throw new ConfigurationError(
      `EMAIL_PROVIDER '${env.EMAIL_PROVIDER}' is not supported (use 'smtp', or 'log' in development).`,
    );
  }
  const smtp = emailProvider === 'smtp' ? smtpSettings(env) : null;
  const eventEmailsSetting = env.EVENT_EMAILS?.trim().toLowerCase() ?? '';
  if (eventEmailsSetting !== '' && eventEmailsSetting !== 'disabled' && eventEmailsSetting !== 'enabled') {
    throw new ConfigurationError(`EVENT_EMAILS must be 'enabled' or 'disabled'.`);
  }

  // Session policy (AD-44): 7 days idle, 30 days absolute.
  const sessionIdleTimeoutMinutes = positiveInteger(
    env.SESSION_IDLE_TIMEOUT_MINUTES,
    'SESSION_IDLE_TIMEOUT_MINUTES',
    7 * 24 * 60,
  );
  const sessionAbsoluteLifetimeMinutes = positiveInteger(
    env.SESSION_ABSOLUTE_LIFETIME_MINUTES,
    'SESSION_ABSOLUTE_LIFETIME_MINUTES',
    30 * 24 * 60,
  );
  if (sessionAbsoluteLifetimeMinutes < sessionIdleTimeoutMinutes) {
    throw new ConfigurationError(
      'SESSION_ABSOLUTE_LIFETIME_MINUTES must not be shorter than SESSION_IDLE_TIMEOUT_MINUTES.',
    );
  }

  return {
    isDevelopment,
    databaseUrl,
    sessionSecrets,
    google: { clientId, hostedDomains, isConfigured: clientId !== '' && hostedDomains.length > 0 },
    trainee: {
      codeLifetimeMinutes: positiveInteger(env.TRAINEE_CODE_LIFETIME_MINUTES, 'TRAINEE_CODE_LIFETIME_MINUTES', 15),
      signInLinkBaseUrl: env.TRAINEE_SIGN_IN_LINK_BASE_URL?.trim() ?? '',
    },
    sessionIdleTimeoutMinutes,
    sessionAbsoluteLifetimeMinutes,
    corsAllowedOrigins: (env.CORS_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    // Writing sign-in codes to the log would let anyone with log access sign in as a trainee: development only.
    emailProvider: smtp ? 'smtp' : emailProvider === 'log' && isDevelopment ? 'log' : 'none',
    smtp,
    eventEmails: eventEmailsSetting === 'enabled',
  };
}

/**
 * The SMTP settings. Messages never quote the password (they are logged); TLS is required from the first byte (port
 * 465), because a Worker cannot upgrade a plain connection the way STARTTLS on port 587 needs.
 */
function smtpSettings(env: Bindings): SmtpSettings {
  const host = env.SMTP_HOST?.trim().toLowerCase() || 'smtp.gmail.com';
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) {
    throw new ConfigurationError('SMTP_HOST must be a host name such as smtp.gmail.com.');
  }
  const port = env.SMTP_PORT?.trim() || '465';
  if (port !== '465') {
    throw new ConfigurationError('SMTP_PORT must be 465 (TLS from the first byte); other ports are not supported.');
  }
  const user = env.SMTP_USER?.trim() ?? '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) {
    throw new ConfigurationError('SMTP_USER must be the e-mail address of the SMTP account.');
  }
  const password = (env.SMTP_APP_PASSWORD ?? '').replace(/\s+/g, '');
  if (password === '') {
    throw new ConfigurationError('SMTP_APP_PASSWORD is not set (a Worker secret, or .dev.vars locally).');
  }
  return { host, port: 465, user, password };
}

/** The staff domains: lower case, trimmed, without duplicates. A blank entry or one that is not a domain is refused. */
function staffDomains(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [];
  const domains = value.split(',').map((domain) => domain.trim().toLowerCase());
  for (const domain of domains) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
      throw new ConfigurationError(`GOOGLE_HOSTED_DOMAIN has an invalid domain: '${domain}'.`);
    }
  }
  return [...new Set(domains)];
}

function positiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new ConfigurationError(`${name} must be a positive whole number.`);
  }

  return number;
}
