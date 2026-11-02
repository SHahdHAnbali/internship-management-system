/**
 * Cloudflare Pages Function: forwards every `/api/*` request, unchanged (method, headers, cookies, body), to the IMS API
 * Worker through the `API` service binding. The browser only ever talks to this origin, so the session cookie stays
 * first-party and `SameSite=Strict` (AD-12), and the Worker itself needs no public URL. See docs/deployment.md.
 */
interface Env {
  API: { fetch(request: Request): Promise<Response> };
}

export const onRequest = ({ request, env }: { request: Request; env: Env }): Promise<Response> =>
  env.API.fetch(request);
