# Authentication & Authorization

Implements PDF §2 and §9: staff sign in with **Google** (company domain only), trainees sign in **passwordless** with a one-time e-mail link or code (15 minutes), and four roles (`Admin`, `HR`, `Employee`, `Trainee`, stored in the PostgreSQL `roles` table) are enforced by the API and the web app.

## Flows

| Who | How | Result |
|---|---|---|
| Staff (Employee, HR, Admin) | `/sign-in` → Google's own sign-in button (Google is the only external provider) → the browser gets a Google ID token → `POST /api/auth/staff/google` | The API verifies the token with Google's public keys (signature, issuer, expiry, **audience = our client ID**), requires a **verified e-mail**, the Workspace **`hd` claim = one of the staff domains** (`stu.najah.edu`, `progineer.net`; AD-45) and an address in that same domain. A new staff account is `Employee`; the one exception is the one-time initial Admin `mohammad.abujoudeh@progineer.net`, created as `Admin` by his own first verified sign-in (AD-46). First sign-in creates the `employees` row with role **Employee**. Then it sets the session cookie and redirects to the role's area |
| Ordinary Google user (Workers API, AD-42) | Same Google button, an account whose `hd` is absent or not one of the `GOOGLE_HOSTED_DOMAIN` staff domains (`stu.najah.edu`, `progineer.net`), or whose e-mail is not in that same domain | Signed in with **no role**: no database record, no staff or trainee access; the web app shows only `/account`. The ASP.NET API refuses these accounts with 403 |
| Trainee | `/sign-in` → e-mail → `POST /api/auth/trainee/request` → e-mail with a 6-digit **code** and a one-time **link** (`/sign-in/verify?token=…`) → `POST /api/auth/trainee/verify` | Valid for **15 minutes**, usable **once**. A newer request invalidates the older one. **5 wrong codes** lock it. Only SHA-256 hashes are stored. The trainee account is created on first successful verification. The request always answers 202, so it can't be used to discover who has an account. Both endpoints are **rate-limited** per client (`RateLimitPerMinute`, default 10) |
| Everyone | `POST /api/auth/sign-out`, `GET /api/auth/me` | `me` returns **only the caller's own** account |

**Session** (Workers API, AD-44): an HttpOnly, `SameSite=Strict`, `path=/` cookie (`ims.session`), `Secure` outside Development, **persistent** (`expires`/`max-age`), so it survives browser restarts. Its content is an encrypted ticket naming a `user_sessions` row.
- **Idle timeout, 7 days** (`SESSION_IDLE_TIMEOUT_MINUTES`): a used cookie is re-issued at most hourly, so the 7 days count from the last activity.
- **Absolute lifetime, 30 days** after sign-in (`SESSION_ABSOLUTE_LIFETIME_MINUTES`): renewal never extends a session beyond it, and the user then signs in again.
- **Sign-out** revokes the session row (`revoked_at`, reason `SignOut`), so a copy of the cookie is refused as well. Other devices keep their own sessions.
- **Signing in again in the same browser** (same or another account) revokes that browser's previous session (reason `Replaced`), in the same transaction that creates the new session: either both happen or neither. A failed sign-in revokes nothing, and other browsers and devices are not affected.
- **On every request** the session row (not revoked, before its absolute end) and the account are re-read from PostgreSQL in one query: a revoked session or deleted account is signed out, and a role changed by an Admin applies immediately.
- **Older cookies**: cookies issued before AD-44 stay valid until their own 8-hour expiry and are moved to a new session on their next request, so the rollout signs nobody out.
- **Testing expiry locally**: `npm run dev:short-sessions` in `backend-workers/` runs the Worker with 2 minutes idle and 5 minutes absolute (command-line overrides; `wrangler.jsonc` is untouched).
- **Web app**: only 401/403 from `GET /api/auth/me` count as signed out. A network or server error shows public pages as usual and, on a protected page, a "can't reach the server" notice. The check is retried automatically (1, 2, 5, 10, then every 30 s, and when the device comes back online), and the user is never sent to sign-in for it.

The ASP.NET API keeps its 8-hour sliding browser-session cookie and re-reads the account on every request.

**Authorization**
- API: a fallback policy requires sign-in everywhere. Public endpoints are explicitly `[AllowAnonymous]` (`/health`, `/api/auth/config`, the sign-in endpoints). Role policies `Admin`, `HR`, `Employee`, `Trainee` (`Ims.Api/Auth`). The Admin API requires `Admin`.
- Web app: `<RequireRole role=…>` (`frontend/src/auth/guards.tsx`) on `/admin`, `/hr`, `/employee`, `/trainee`. Signed-out visitors go to `/sign-in?returnUrl=…`, and a signed-in user with another role goes to their own area. The guards are UX only; the API is the security boundary.
- After sign-in: Admin → `/admin`, HR → `/hr`, Employee → `/employee`, Trainee → `/trainee`. The HR/Employee/Trainee areas show only a landing page until their modules are built.

## External configuration you must provide

Nothing below is invented or defaulted. Without it, the flow reports clearly that it is not configured.

| Setting | Where | What |
|---|---|---|
| `Authentication:Google:ClientId` | user-secrets (dev) / host secret store | OAuth 2.0 **Web application** client ID from Google Cloud Console (APIs & Services → Credentials). **Authorized JavaScript origins**: `http://localhost:4200` for development, plus the production web origin. No client secret is needed (ID-token flow) |
| `Authentication:Google:HostedDomain` | same | The company's Google Workspace domain, e.g. `company.com` (Q10) |
| First Admin | one-time operator step | Accounts start as Employee, and only an Admin can grant roles (PDF §2), so the first Admin must be set once **after that person's first Google sign-in**: `docker exec -it ims-db-1 psql -U ims -d ims_dev -c "UPDATE employees SET role = 'Admin' WHERE email = 'name@company.com';"` (recorded in `audit_logs` with actor `Database`). How to bootstrap in production is open (Q17) |
| `Email:Provider` (+ provider credentials) | appsettings / secrets | **Development** uses `Log`: sign-in e-mails are written to the API console (look for `DEVELOPMENT E-MAIL`). **Production**: the PDF names SendGrid or Amazon SES; the owner selected **SendGrid** (AD-53), whose account is awaiting reactivation. The production Worker runs with `EMAIL_PROVIDER` empty, so trainee code requests return 503 and trainees cannot sign in until it works (also needs the sender, NEW-01, and the domain, Q10) |
| `Authentication:Trainee:SignInLinkBaseUrl` | appsettings | Public URL of the web app, used in the e-mailed link (`http://localhost:4200` in Development) |
| Data Protection key storage | hosting | ASP.NET API only (not deployed): persist the cookie-encryption keys. The production Worker encrypts sessions with the `SESSION_SECRET` Workers secret instead (AD-40) |

```bash
# Development: set the Google values once (from backend/)
dotnet user-secrets set "Authentication:Google:ClientId" "<client-id>.apps.googleusercontent.com" --project src/Ims.Api
dotnet user-secrets set "Authentication:Google:HostedDomain" "<company-domain>" --project src/Ims.Api
```

## Try it locally
1. `docker compose up -d`, then `cd backend && dotnet ef database update -p src/Ims.Infrastructure -s src/Ims.Api`, then `dotnet run --project src/Ims.Api`.
2. `cd frontend && npm start` (React/Vite on port 4200), then open http://localhost:4200 and choose **Sign in**.
3. Trainee: enter any e-mail, copy the code (or link) from the API console, and you land in `/trainee`.
4. Staff: needs the Google settings above, plus the first-Admin step for `/admin`.

## Tests
- Backend (`AuthApiTests`, `RateLimitTests`, `TraineeSignInCodeTests`) run against real PostgreSQL with the real cookie. Google's token check, e-mail and the clock are test doubles, so domain rules, auto-Employee, role changes, 15-minute expiry, single use, lockout, rate limiting, isolation and sign-out are all covered.
- Frontend (Vitest + React Testing Library): guards (every role/area combination), the API client, the sign-in page flow, validation and error messages.
- Not covered automatically: a real Google account (needs the client ID).
