/**
 * api/config.js — Vercel Serverless Function
 * ------------------------------------------
 * Exposes ONLY the public Supabase URL and public Anon Key from Vercel
 * Environment Variables so the static HTML/CSS/JS frontend can connect
 * without hardcoding credentials in GitHub.
 *
 * NEVER expose SUPABASE_SERVICE_ROLE_KEY here.
 */

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json');

  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(503).json({
      error: 'SUPABASE_URL and SUPABASE_ANON_KEY are not configured in Vercel environment variables.',
    });
  }

  return res.status(200).json({
    supabaseUrl,
    supabaseAnonKey,
  });
}
