/**
 * config.js — Runtime Supabase Configuration Loader
 * -------------------------------------------------
 * Never hardcodes credentials in source code.
 * Resolution order:
 *   1. Optional gitignored `window.__ENV__` (for local static dev via js/env.js).
 *   2. Browser localStorage override (for quick local testing via the Setup screen).
 *   3. Vercel Serverless Function `/api/config` (reads Vercel env vars in production).
 */

const LOCAL_CFG_KEY = 'takatrack_supabase_config_v1';
let cachedConfig = null;

export function saveLocalConfig(supabaseUrl, supabaseAnonKey) {
  const cfg = {
    supabaseUrl: String(supabaseUrl || '').trim().replace(/\/+$/, ''),
    supabaseAnonKey: String(supabaseAnonKey || '').trim(),
  };
  localStorage.setItem(LOCAL_CFG_KEY, JSON.stringify(cfg));
  cachedConfig = cfg;
  return cfg;
}

export function clearLocalConfig() {
  localStorage.removeItem(LOCAL_CFG_KEY);
  cachedConfig = null;
}

export async function loadConfig() {
  if (cachedConfig) return cachedConfig;

  // 1. Check local dev window.__ENV__ if present
  if (typeof window !== 'undefined' && window.__ENV__?.SUPABASE_URL && window.__ENV__?.SUPABASE_ANON_KEY) {
    cachedConfig = {
      supabaseUrl: window.__ENV__.SUPABASE_URL,
      supabaseAnonKey: window.__ENV__.SUPABASE_ANON_KEY,
    };
    return cachedConfig;
  }

  // 2. Check localStorage config saved from the local setup screen
  try {
    const saved = localStorage.getItem(LOCAL_CFG_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (isConfigValid(parsed)) {
        cachedConfig = parsed;
        return cachedConfig;
      }
    }
  } catch {
    // Ignore storage parse errors
  }

  // 3. Fetch public client config from Vercel Serverless Function
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data.supabaseUrl && data.supabaseAnonKey) {
        cachedConfig = {
          supabaseUrl: data.supabaseUrl,
          supabaseAnonKey: data.supabaseAnonKey,
        };
        return cachedConfig;
      }
    }
  } catch {
    // Offline or running on a plain static server without /api/config
  }

  return null;
}

export function isConfigValid(cfg) {
  return Boolean(
    cfg
    && typeof cfg.supabaseUrl === 'string'
    && cfg.supabaseUrl.startsWith('https://')
    && typeof cfg.supabaseAnonKey === 'string'
    && cfg.supabaseAnonKey.length > 20
  );
}
