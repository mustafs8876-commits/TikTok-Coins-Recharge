// DEMO ONLY: sends only amount, currency and DEMO status.
// This does not charge a card or move real money.
(() => {
  const SUPABASE_URL = 'https://yetpcbynwvyiaaypgdtv.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_spZvWCy6iGEmBhUVZW5yYg_tXhCZbb2';

  function loadSupabase() {
    if (window.supabase?.createClient) return Promise.resolve(window.supabase);
    return new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-supabase-sdk]');
      if (existing) {
        existing.addEventListener('load', () => resolve(window.supabase), { once: true });
        existing.addEventListener('error', reject, { once: true });
        if (window.supabase?.createClient) resolve(window.supabase);
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
      script.async = true;
      script.dataset.supabaseSdk = 'true';
      script.onload = () => resolve(window.supabase);
      script.onerror = () => reject(new Error('Supabase SDK failed to load'));
      document.head.appendChild(script);
    });
  }

  let clientPromise;
  window.syncTikTokDemoAmount = async function (rawAmount) {
    const amount = Number.parseFloat(rawAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      console.error('[DEMO sync] Invalid amount; no record sent.');
      return false;
    }

    try {
      const sdk = await (clientPromise ||= loadSupabase());
      if (!sdk?.createClient) throw new Error('Supabase SDK unavailable');
      const client = sdk.createClient(SUPABASE_URL, SUPABASE_KEY);
      const { error } = await client
        .from('demo_transactions')
        .insert({ amount: Number(amount.toFixed(2)), currency: 'USD', status: 'DEMO' });

      if (error) throw error;
      console.info('[DEMO sync] Amount sent to demo history:', amount.toFixed(2), 'USD');
      return true;
    } catch (error) {
      console.error('[DEMO sync] Could not save demo transaction:', error);
      return false;
    }
  };
})();
