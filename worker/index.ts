import { Env } from './types';
import { runSessionSync } from './session-sync';

// The portal and API hold patient names and phones, so every request needs the portal password
// (HTTP Basic Auth, any username). Without PORTAL_PASSWORD set, everything is refused.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!(await isAuthorized(request, env.PORTAL_PASSWORD))) {
      return new Response('Login required', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Dental Home Leads", charset="UTF-8"' }
      });
    }

    const pathname = new URL(request.url).pathname;

    if (pathname === '/api/sync-sessions') {
      return jsonResponse(() => runSessionSync(env));
    }

    if (pathname === '/api/sessions') {
      return jsonResponse(async () => {
        const { results } = await env.DB!.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT 100').all();
        return { sessions: results };
      });
    }

    if (pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // Default to serving static assets (dist/) with SPA fallback
    return env.ASSETS.fetch(request);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runSessionSync(env));
  }
};

async function isAuthorized(request: Request, password: string | undefined): Promise<boolean> {
  if (!password) return false;
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  let supplied = '';
  try {
    const decoded = atob(header.slice(6));
    supplied = decoded.slice(decoded.indexOf(':') + 1);
  } catch (e) {
    return false;
  }
  // Compare digests so the check takes the same time whatever was typed
  const digest = async (s: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return crypto.subtle.timingSafeEqual(await digest(supplied), await digest(password));
}

async function jsonResponse(fn: () => Promise<unknown>): Promise<Response> {
  try {
    return new Response(JSON.stringify(await fn()), { headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    console.error('API error:', err);
    return new Response(JSON.stringify({ error: err.message || 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
