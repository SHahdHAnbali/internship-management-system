/** `/health` of the IMS API Worker (database connectivity), reached through the same service binding as `/api/*`. */
interface Env {
  API: { fetch(request: Request): Promise<Response> };
}

export const onRequest = ({ request, env }: { request: Request; env: Env }): Promise<Response> =>
  env.API.fetch(request);
