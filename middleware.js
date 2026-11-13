const encoder = new TextEncoder();

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {
    name: 'HMAC', hash: 'SHA-256'
  }, false, ['sign']);
  return bytesToHex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

function loginPage() {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Access required</title><style>
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#171717;font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  main{width:min(90%,390px);padding:30px;border-radius:18px;background:#fff;box-shadow:0 20px 70px #0008}
  h1{font-size:23px;margin:0 0 9px}p{color:#666;font-size:14px;margin:0 0 22px}
  input,button{width:100%;padding:15px;border-radius:9px;font-size:16px}input{border:1px solid #ddd;margin-bottom:12px}
  button{border:0;background:#fe2c55;color:#fff;font-weight:700;cursor:pointer}button:disabled{opacity:.6}
  #error{min-height:20px;color:#d21b48;font-size:13px;margin:0 0 10px}
  </style><main><h1>Access required</h1><p>Enter your access key to continue.</p>
  <form id="form"><input id="key" type="password" autocomplete="current-password" required placeholder="Access key">
  <div id="error" role="alert"></div><button id="submit">Continue</button></form></main>
  <script>
  const form=document.getElementById('form'),key=document.getElementById('key'),error=document.getElementById('error'),button=document.getElementById('submit');
  form.addEventListener('submit',async e=>{e.preventDefault();button.disabled=true;error.textContent='';
  try{const r=await fetch('/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:key.value})});
  const data=await r.json().catch(()=>({}));if(!r.ok||!data.ok){error.textContent=data.error==='rate_limited'?'Too many attempts. Try later.':'Invalid key.';key.value='';}
  else{sessionStorage.setItem('tiktokPasswordVerified','true');location.replace('/');}}
  catch{error.textContent='Could not verify access. Try again.';}finally{button.disabled=false;}});
  </script></html>`;
}

export default async function middleware(request) {
  const url = new URL(request.url);
  if (url.pathname === '/api/auth') return;

  const secret = process.env.SITE_SESSION_SECRET;
  if (!secret) {
    return new Response('Access is not configured. Add SITE_ACCESS_KEY and SITE_SESSION_SECRET in Vercel Environment Variables.', {
      status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }

  const raw = request.cookies.get('site_access')?.value || '';
  const dot = raw.indexOf('.');
  if (dot > 0) {
    const expiresAt = raw.slice(0, dot);
    const signature = raw.slice(dot + 1);
    if (/^\\d{13}$/.test(expiresAt) && Number(expiresAt) > Date.now()) {
      const expected = await sign(expiresAt, secret);
      if (signature.length === expected.length) {
        let diff = 0;
        for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
        if (diff === 0) return;
      }
    }
  }

  return new Response(loginPage(), {
    status: 401,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  });
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
