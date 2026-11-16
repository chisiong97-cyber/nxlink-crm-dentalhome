import { Env } from './types';
import { runSessionSync } from './session-sync';

// The portal and API sit behind Cloudflare Access, which handles login before requests reach the Worker
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
