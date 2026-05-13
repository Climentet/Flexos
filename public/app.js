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

async function updatePushStatus(registration) {
  const statusEl = document.getElementById('pushStatus');
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    statusEl.textContent = 'Estado: este navegador no soporta push';
    return;
  }

  const permission = Notification.permission;
  const subscription = await registration.pushManager.getSubscription();

  if (permission === 'denied') {
    statusEl.textContent = 'Estado: permiso bloqueado por el navegador';
    return;
  }

  if (subscription) {
    statusEl.textContent = 'Estado: activadas y listas';
    return;
  }

  if (permission === 'granted') {
    statusEl.textContent = 'Estado: permiso concedido, falta suscripcion';
    return;
  }

  statusEl.textContent = 'Estado: no activadas';
}

async function enablePush() {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    alert('Tu navegador no soporta notificaciones push.');
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    alert('Permiso de notificaciones no concedido.');
    return;
  }

  const registration = await navigator.serviceWorker.register('/sw.js');
  const publicKeyRes = await api('/api/push/public-key');
  if (!publicKeyRes || !publicKeyRes.publicKey) {
    alert('No se pudo obtener la clave de notificaciones.');
    return;
  }

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKeyRes.publicKey)
    });
  }

  const saveRes = await api('/api/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({ subscription })
  });

  if (saveRes && saveRes.ok) {
    await updatePushStatus(registration);
    alert('Push activadas. Ya te llegan los avisos del ranking.');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  loadAll();

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', (e) => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
    e.target.classList.add('active');
    document.getElementById('rankingTab').classList.toggle('hidden', e.target.dataset.tab !== 'ranking');
    document.getElementById('addTab').classList.toggle('hidden', e.target.dataset.tab !== 'add');
  }));

  const registration = ('serviceWorker' in navigator) ? await navigator.serviceWorker.register('/sw.js') : null;
  if (registration) {
    await updatePushStatus(registration);
  } else {
    document.getElementById('pushStatus').textContent = 'Estado: este navegador no soporta push';
  }

  document.getElementById('enablePushBtn').addEventListener('click', async () => {
    try {
      await enablePush();
    } catch (error) {
      alert(`Error activando push: ${error.message}`);
    }
  });

  document.getElementById('pushForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('pushTitle').value.trim() || 'OPERACION POLLON';
    const message = document.getElementById('pushBody').value.trim();
    if (!message) return alert('Escribe un mensaje.');

    const res = await api('/api/push/broadcast', {
      method: 'POST',
      body: JSON.stringify({ title, message, url: '/app.html' })
    });

    if (res && res.ok) {
      alert(`Notificacion enviada. Exito: ${res.sent}, fallos: ${res.failed}.`);
      document.getElementById('pushBody').value = '';
    }
  });

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
