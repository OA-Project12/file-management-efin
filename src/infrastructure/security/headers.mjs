export function securityHeaders(environment = process.env.NODE_ENV, supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL) {
  const production = environment === 'production';
  let origin = '';
  if (supabaseUrl) {
    const url = new URL(supabaseUrl);
    if (url.username || url.password || (production && url.protocol !== 'https:')) throw new Error('Invalid public Supabase origin');
    origin = url.origin;
  }
  const policy = [
    "default-src 'self'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'",
    `script-src 'self' 'unsafe-inline'${production ? '' : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'", "font-src 'self'",
    `connect-src 'self' ${origin}${production ? '' : ' ws://localhost:* ws://127.0.0.1:*'}`,
    `img-src 'self' data: blob: ${origin}`, `frame-src 'self' ${origin}`,
    ...(production ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
  return [
    { key: 'Content-Security-Policy', value: policy },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'no-referrer' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ...(production ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000' }] : []),
  ];
}
