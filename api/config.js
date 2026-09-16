/* Vercel serverless function: hands the browser the public Supabase settings.
   The values come from environment variables, so no key is ever committed.
   Set SUPABASE_URL and SUPABASE_ANON_KEY in your Vercel project settings.
   Only the anon (publishable) key belongs here — never the service role key. */
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const anonKey = (process.env.SUPABASE_ANON_KEY || '').trim();

  if (!url || !anonKey) {
    res.status(200).json({ configured: false });
    return;
  }
  res.status(200).json({ configured: true, url, anonKey });
}
