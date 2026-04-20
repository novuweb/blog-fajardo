function getToken() { return localStorage.getItem('admin_token'); }
function getUser()  { try { return JSON.parse(localStorage.getItem('admin_user')); } catch { return null; } }
function authHeaders() { return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() }; }
function requireAuth() { if (!getToken()) location.href = '/admin/'; }
function logout() { localStorage.removeItem('admin_token'); localStorage.removeItem('admin_user'); location.href = '/admin/'; }

let _toastTimer;
function showToast(msg, type) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'show' + (type ? ' ' + type : '');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.className = ''; }, 2800);
}

function openModal(id)  { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
}
