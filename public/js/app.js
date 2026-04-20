const API = '';

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });
}

function postCard(p) {
  const badge = `<span class="card-cat" style="background:${p.category_color||'#888'}">${p.category_name}</span>`;
  const img = p.featured_image
    ? `<div class="card-img"><img src="${p.featured_image}" alt="${p.title}" loading="lazy"></div>`
    : `<div class="card-img"><div class="card-img-placeholder">🌴</div></div>`;
  return `
    <article class="post-card" onclick="location.href='/post.html?id=${p.slug}'">
      ${img}
      <div class="card-body">
        ${badge}
        <h3 class="card-title">${p.title}</h3>
        <p class="card-excerpt">${p.excerpt}</p>
        <div class="card-meta">
          <span>${formatDate(p.published_at||p.created_at)}</span>
          <span class="card-meta-sep"></span>
          <span>${p.reading_time_minutes} min lectura</span>
        </div>
      </div>
    </article>`;
}

// ── HOME ──
if (document.getElementById('latestPosts')) {
  fetch(`${API}/api/posts?limit=3`)
    .then(r => r.json())
    .then(({ data }) => {
      document.getElementById('latestPosts').innerHTML = data.length
        ? data.map(postCard).join('')
        : '<p style="color:var(--muted)">No hay artículos publicados aún.</p>';
      document.getElementById('statPosts').textContent = data.length;
    });

  fetch(`${API}/api/categories`)
    .then(r => r.json())
    .then(({ data }) => {
      document.getElementById('categoriesGrid').innerHTML = data.map(c => `
        <div class="cat-card" onclick="location.href='/blog.html?cat=${c.id}'">
          <div class="cat-icon">${c.icon||'📁'}</div>
          <div class="cat-name">${c.name}</div>
          <div class="cat-desc">${c.description||''}</div>
          <div class="cat-count">${c.post_count} artículo${c.post_count!==1?'s':''}</div>
        </div>`).join('');
      document.getElementById('statCats').textContent = data.length;
    });
}

// ── NAVBAR ──
const navbar = document.getElementById('navbar');
if (navbar) window.addEventListener('scroll', () => navbar.classList.toggle('scrolled', scrollY > 40));

const navToggle = document.getElementById('navToggle');
const navLinks = document.getElementById('navLinks');
if (navToggle) navToggle.addEventListener('click', () => navLinks.classList.toggle('open'));
