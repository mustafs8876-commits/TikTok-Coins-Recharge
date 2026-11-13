const encoder = new TextEncoder();

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return bytesToHex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

export default async function middleware(request) {
  const url = new URL(request.url);
  if (url.pathname === '/api/auth') return;

  const secret = process.env.SITE_SESSION_SECRET;
  if (!secret) {
    return new Response('Site access is not configured. Set SITE_SESSION_SECRET and SITE_ACCESS_KEY in Vercel.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }

  const raw = request.cookies.get('site_access')?.value || '';
  const dot = raw.indexOf('.');
  if (dot > 0) {
    const expiresAt = raw.slice(0, dot);
    const signature = raw.slice(dot + 1);
    if (/^\d{13}$/.test(expiresAt) && Number(expiresAt) > Date.now()) {
      const expected = await sign(expiresAt, secret);
      if (signature.length === expected.length) {
        let diff = 0;
        for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
        if (diff === 0) return;
      }
    }
  }

  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }

  const loginUrl = new URL('/', request.url);
  loginUrl.searchParams.set('access', 'required');
  return Response.redirect(loginUrl, 307);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)']
};
