# Admin Preview Mode (local development only)

Lets you open and click through every Admin page **without signing in** (authentication is not implemented yet), using realistic in-browser mock data.

## Start / stop

```bash
cd frontend
nvm use                   # Node 22
npm run start:preview     # = vite --mode admin-preview
```

Open **http://localhost:4200/admin** (Fields, Evaluation criteria, Users & roles, Notification settings).
Stop it with `Ctrl+C`. To work against the real API again, use `npm start`. Preview Mode is **off** in every other command.

The backend does not need to be running: Admin requests never leave the browser in Preview Mode.

## What you get
- Sample fields, criteria (Arabic and English), staff users with each staff role, and the 7/3/5-day settings.
- Working tables, dialogs, toggles, role selects and forms. Adds and edits update the mock in memory, and **a page reload restores the sample data**.
- The same validation and error codes as the real API: empty name or weight ≤ 0 → 400, unknown id → 404, duplicate field name → 409 (try adding "backend").
- A **"Preview mode: local mock data, no changes are saved"** banner on every page. Successful saves say *"Done in preview only. Nothing was saved"* instead of *"Saved"*.
- Arabic RTL / English LTR switch, responsive layouts (use the browser's device toolbar).

## Why it cannot reach production
1. **Not compiled into real builds.** `main.tsx` imports the mock only inside `if (import.meta.env.MODE === 'admin-preview')`. Vite replaces `MODE` with a constant, so every other build drops the branch. The mock additionally requires `import.meta.env.DEV` (the dev server), so even a built bundle in that mode cannot activate it. This was checked by searching the built files.
2. **Runtime guard.** `previewActive` (`src/preview/mode.ts`) is true only on the dev server in that mode **and** when the page is served from `localhost` / `127.0.0.1`.
3. **Frontend only.** The mock answers `/api/admin/*` inside the API client (`setApiMock` in `src/lib/api.ts`). The backend, its authentication and its Admin-only authorization are unchanged, and the real API still returns 401/403 without sign-in.

## Files
| File | Role |
|---|---|
| `src/main.tsx` | Loads the mock only in the `admin-preview` mode |
| `src/preview/mode.ts` | `previewActive` flag (dev server + localhost + mode) |
| `src/components/PreviewBanner.tsx` | The banner |
| `src/features/admin/preview/` | Mock data, in-memory store (+ tests), `installAdminPreview` |

When real sign-in exists, delete the `preview` configuration, the files above and the `start:preview` script, or keep them for UI work.
