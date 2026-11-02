# IMS web app (React)

React 19 + TypeScript + Vite + React Router + Tailwind CSS (SCSS for design tokens). Talks to the ASP.NET Core API in `../backend`.

```bash
nvm use                  # Node 22 (repo root .nvmrc)
npm install
npm start                # http://localhost:4200, proxies /api → http://localhost:5106
npm run start:preview    # Admin Preview Mode: /admin with in-browser mock data, no sign-in (docs/admin-preview.md)
npm run build            # type-check + production build → dist/
npm test -- --run        # Vitest + React Testing Library
npm run lint             # oxlint
npm run deploy           # Cloudflare Pages (docs/deployment.md)
```

See `../docs/design-system.md` and `../CLAUDE.md` for conventions.
