import { Env } from './types';

const NXLINK_BASE = 'https://app.nxlink.ai';
const TOKEN_KEY = 'plat_token';
const BLOCK_KEY = 'login_blocked_until';
const LOGIN_BACKOFF_MS = 30 * 60 * 1000;

const loginHeaders = {
  system_id: '5',
  lang: 'en_US',
  time_zone: 'UTC+08:00',
  currentdomain: 'app.nxlink.ai',
  'content-type': 'application/json;charset=UTF-8'
};

// Logs in the same way the NxLink web login page does (no browser needed).
// NxLink appears to allow one active token per account, so only call this when the saved token stops working.
async function loginToNxlink(env: Env): Promise<string> {
  const kv = env.NXLINK_TOKEN;
  if (!kv || !env.NXLINK_ACCOUNT || !env.NXLINK_PASSWORD) {
    throw new Error('NXLINK login not configured (needs NXLINK_TOKEN KV binding, NXLINK_ACCOUNT and NXLINK_PASSWORD).');
  }

  // Back off after a failed login so repeated attempts don't trigger NxLink's captcha or lock the account
  const blockedUntil = Number((await kv.get(BLOCK_KEY)) || 0);
  if (blockedUntil > Date.now()) {
    throw new Error(`NXLINK login paused after a failed attempt; retrying after ${new Date(blockedUntil).toISOString()}.`);
  }

  try {
    const captchaResp = await fetch(`${NXLINK_BASE}/admin/saas_plat/captcha/start_image_verify`, { headers: loginHeaders });
    const captchaData: any = await captchaResp.json().catch(() => ({}));

    const loginResp = await fetch(`${NXLINK_BASE}/admin/saas_plat/user/login`, {
      method: 'PUT',
      headers: loginHeaders,
      body: JSON.stringify({
        email: env.NXLINK_ACCOUNT,
        password: env.NXLINK_PASSWORD,
        graphVerificationCode: '',
        key: captchaData.data?.key || '',
        deviceType: 'Browser',
        deviceUniqueIdentification: crypto.randomUUID(),
        deviceName: 'Chrome',
        deviceVersion: '156.0.0.0',
        loginMethod: 0
      })
    });
    const loginData: any = await loginResp.json().catch(() => ({}));
    const token = loginData.data?.token;
    if (!loginResp.ok || loginData.code !== 0 || !token) {
      throw new Error(`NXLINK login failed (HTTP ${loginResp.status}, code ${loginData.code}): ${loginData.message || 'no token returned'}`);
    }

    await kv.put(TOKEN_KEY, token);
    console.log('[NXLINK Auth] Logged in and saved a new plat_token');
    return token;
  } catch (err) {
    await kv.put(BLOCK_KEY, String(Date.now() + LOGIN_BACKOFF_MS));
    throw err;
  }
}

// Returns a token: the saved one from KV, or a fresh login when there is none.
export async function getNxlinkToken(env: Env, forceLogin = false): Promise<string> {
  if (!forceLogin) {
    const saved = await env.NXLINK_TOKEN?.get(TOKEN_KEY);
    if (saved) return saved;
  }
  return loginToNxlink(env);
}

// Returns a token that is confirmed to belong to the expected tenant, logging in again once if the saved token was revoked.
export async function getVerifiedNxlinkToken(env: Env, expectedTenantId: number): Promise<string> {
  let token = await getNxlinkToken(env);
  const checkTenant = () => fetch(`${NXLINK_BASE}/gw/v1/omni/admin/tenants`, { headers: { authorization: token } });

  let resp = await checkTenant();
  if (resp.status === 401 || resp.status === 403) {
    token = await getNxlinkToken(env, true);
    resp = await checkTenant();
  }
  if (!resp.ok) {
    throw new Error(`Failed to verify tenant with NXLINK API (HTTP ${resp.status}). Aborting sync.`);
  }

  const data: any = await resp.json();
  const activeTenantId = data.data?.tenant_id;
  if (activeTenantId !== expectedTenantId) {
    throw new Error(`Tenant safety violation: Active token tenant is ${activeTenantId}, expected ${expectedTenantId}. Aborting sync.`);
  }
  return token;
}
