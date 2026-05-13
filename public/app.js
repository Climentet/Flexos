async function api(path, opts) {
  const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  if (res.status === 401) { alert('Sesion expirada. Vuelve al inicio.'); location.href = '/'; return null; }
  return res.json();
}

function renderTable(container, rows, cols) {
  const el = document.getElementById(container);
  if (!rows || rows.length === 0) { el.innerHTML = '<div class="card muted">Sin datos</div>'; return; }
  let html = '<div class="card"><table><thead><tr>' + cols.map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>';
  for (const r of rows) { html += '<tr>' + cols.map((k) => `<td>${r[k] ?? ''}</td>`).join('') + '</tr>'; }
  html += '</tbody></table></div>';
  el.innerHTML = html;
}

async function loadAll() {
  const ab = await api('/api/ranking?exercise=abdominales');
  const fl = await api('/api/ranking?exercise=flexiones');
  const all = await api('/api/ranking');
  renderTable('rankAb', ab, ['name', 'total']);
  renderTable('rankFl', fl, ['name', 'total']);
  renderTable('rankAll', all, ['name', 'abdominales', 'flexiones', 'total']);
}

const allowedParticipants = new Set([
  'Gykas Coleman',
  'Legionario Makri',
  'Bochenko Matamoros',
  'Dei V',
  'Clayment',
  'THE F*KING BERNI',
  'Kekong Kekongo'
]);

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function setupPushAutomatically() {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return;
  }

  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    let subscription = await registration.pushManager.getSubscription();

    if (!subscription && Notification.permission === 'default') {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;
    }

    if (!subscription && Notification.permission === 'granted') {
      const publicKeyRes = await api('/api/push/public-key');
      if (publicKeyRes && publicKeyRes.publicKey) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKeyRes.publicKey)
        });
      }
    }

    if (subscription) {
      await api('/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({ subscription })
      });
    }
  } catch (error) {
    console.error('Error setting up push:', error);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  loadAll();
  setupPushAutomatically();

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', (e) => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
    e.target.classList.add('active');
    document.getElementById('rankingTab').classList.toggle('hidden', e.target.dataset.tab !== 'ranking');
    document.getElementById('addTab').classList.toggle('hidden', e.target.dataset.tab !== 'add');
  }));

  document.getElementById('entryForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('name').value.trim();
    const exercise = document.getElementById('exercise').value;
    const count = document.getElementById('count').value;
    if (!name || !count) return alert('Rellena todos los campos');
    if (!allowedParticipants.has(name)) return alert('El participante no esta permitido');
    const res = await api('/api/entry', { method: 'POST', body: JSON.stringify({ name, exercise, count }) });
    if (res && res.ok) { alert('Registro guardado y push lanzada'); document.getElementById('entryForm').reset(); loadAll(); }
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => { await fetch('/logout', { method: 'POST' }); location.href = '/'; });
});

