const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { read, write } = require('./lib/db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fajardo-blog-secret-2025';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// Multer for image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'public/uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/image\/(jpeg|png|gif|webp)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Solo se permiten imágenes'));
  }
});

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ success: false, message: 'No autorizado' });
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Token inválido' });
  }
}

function slugify(text) {
  return text.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

function calcReadingTime(html) {
  const words = html.replace(/<[^>]+>/g, '').split(/\s+/).length;
  return Math.max(1, Math.ceil(words / 200));
}

// ─── AUTH ───
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const db = read();
  const user = db.users.find(u => u.email === email);
  if (!user) return res.status(401).json({ success: false, message: 'Credenciales incorrectas' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ success: false, message: 'Credenciales incorrectas' });
  user.last_login = new Date().toISOString();
  write(db);
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ success: true, data: { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } } });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ success: true, data: req.user });
});

// ─── POSTS ───
app.get('/api/posts', (req, res) => {
  const db = read();
  const { category, search, status, page = 1, limit = 12 } = req.query;
  let posts = db.posts.filter(p => !p.deleted_at);
  if (!req.headers.authorization) posts = posts.filter(p => p.status === 'published');
  if (category) posts = posts.filter(p => p.category_id === category || p.slug === category);
  if (status) posts = posts.filter(p => p.status === status);
  if (search) {
    const q = search.toLowerCase();
    posts = posts.filter(p => p.title.toLowerCase().includes(q) || p.excerpt.toLowerCase().includes(q));
  }
  posts.sort((a, b) => new Date(b.published_at || b.created_at) - new Date(a.published_at || a.created_at));
  const total = posts.length;
  const offset = (page - 1) * limit;
  const data = posts.slice(offset, offset + parseInt(limit));
  res.json({ success: true, data, total, page: parseInt(page), pages: Math.ceil(total / limit) });
});

app.get('/api/posts/:id', (req, res) => {
  const db = read();
  const post = db.posts.find(p => (p.id === req.params.id || p.slug === req.params.id) && !p.deleted_at);
  if (!post) return res.status(404).json({ success: false, message: 'Post no encontrado' });
  if (post.status === 'draft' && !req.headers.authorization) return res.status(404).json({ success: false, message: 'Post no encontrado' });
  post.views_count = (post.views_count || 0) + 1;
  write(db);
  res.json({ success: true, data: post });
});

app.post('/api/posts', authMiddleware, (req, res) => {
  const { title, content, excerpt, featured_image, category_id, seo_description, status = 'draft' } = req.body;
  if (!title || !content || !category_id) return res.status(400).json({ success: false, message: 'Faltan campos requeridos' });
  const db = read();
  const cat = db.categories.find(c => c.id === category_id);
  if (!cat) return res.status(400).json({ success: false, message: 'Categoría no encontrada' });
  const now = new Date().toISOString();
  const post = {
    id: `post-${uuidv4().slice(0, 8)}`,
    title,
    slug: slugify(title),
    content,
    excerpt: excerpt || content.replace(/<[^>]+>/g, '').slice(0, 200) + '...',
    featured_image: featured_image || null,
    category_id,
    category_name: cat.name,
    category_color: cat.color,
    author: req.user.name,
    status,
    created_at: now,
    updated_at: now,
    published_at: status === 'published' ? now : null,
    seo_description: seo_description || '',
    reading_time_minutes: calcReadingTime(content),
    views_count: 0,
    deleted_at: null
  };
  db.posts.push(post);
  if (status === 'published') cat.post_count = (cat.post_count || 0) + 1;
  write(db);
  res.status(201).json({ success: true, data: post });
});

app.put('/api/posts/:id', authMiddleware, (req, res) => {
  const db = read();
  const idx = db.posts.findIndex(p => p.id === req.params.id && !p.deleted_at);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Post no encontrado' });
  const post = db.posts[idx];
  const oldStatus = post.status;
  const { title, content, excerpt, featured_image, category_id, seo_description, status } = req.body;
  if (title) { post.title = title; post.slug = slugify(title); }
  if (content) { post.content = content; post.reading_time_minutes = calcReadingTime(content); }
  if (excerpt !== undefined) post.excerpt = excerpt;
  if (featured_image !== undefined) post.featured_image = featured_image;
  if (seo_description !== undefined) post.seo_description = seo_description;
  if (category_id) {
    const cat = db.categories.find(c => c.id === category_id);
    if (cat) { post.category_id = category_id; post.category_name = cat.name; post.category_color = cat.color; }
  }
  if (status) {
    const wasDraft = oldStatus === 'draft';
    const nowPublished = status === 'published';
    post.status = status;
    if (wasDraft && nowPublished) post.published_at = new Date().toISOString();
    if (!nowPublished) post.published_at = null;
  }
  post.updated_at = new Date().toISOString();
  db.posts[idx] = post;
  write(db);
  res.json({ success: true, data: post });
});

app.delete('/api/posts/:id', authMiddleware, (req, res) => {
  const db = read();
  const post = db.posts.find(p => p.id === req.params.id && !p.deleted_at);
  if (!post) return res.status(404).json({ success: false, message: 'Post no encontrado' });
  post.deleted_at = new Date().toISOString();
  write(db);
  res.json({ success: true, message: 'Post eliminado' });
});

// ─── CATEGORIES ───
app.get('/api/categories', (req, res) => {
  const db = read();
  res.json({ success: true, data: db.categories });
});

app.post('/api/categories', authMiddleware, (req, res) => {
  const { name, description = '', color = '#888888', icon = '📁' } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'El nombre es requerido' });
  const db = read();
  if (db.categories.find(c => c.name.toLowerCase() === name.toLowerCase())) {
    return res.status(400).json({ success: false, message: 'Categoría ya existe' });
  }
  const cat = { id: `cat-${uuidv4().slice(0, 8)}`, name, slug: slugify(name), description, color, icon, post_count: 0 };
  db.categories.push(cat);
  write(db);
  res.status(201).json({ success: true, data: cat });
});

app.put('/api/categories/:id', authMiddleware, (req, res) => {
  const db = read();
  const cat = db.categories.find(c => c.id === req.params.id);
  if (!cat) return res.status(404).json({ success: false, message: 'Categoría no encontrada' });
  const { name, description, color, icon } = req.body;
  if (name) { cat.name = name; cat.slug = slugify(name); }
  if (description !== undefined) cat.description = description;
  if (color) cat.color = color;
  if (icon) cat.icon = icon;
  write(db);
  res.json({ success: true, data: cat });
});

app.delete('/api/categories/:id', authMiddleware, (req, res) => {
  const db = read();
  const idx = db.categories.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Categoría no encontrada' });
  const hasPost = db.posts.find(p => p.category_id === req.params.id && !p.deleted_at);
  if (hasPost) return res.status(400).json({ success: false, message: 'No se puede eliminar: tiene posts asignados' });
  db.categories.splice(idx, 1);
  write(db);
  res.json({ success: true, message: 'Categoría eliminada' });
});

// ─── UPLOAD ───
app.post('/api/upload', authMiddleware, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No se subió ningún archivo' });
  res.json({ success: true, data: { url: `/uploads/${req.file.filename}`, filename: req.file.filename } });
});

// ─── STATS ───
app.get('/api/stats', authMiddleware, (req, res) => {
  const db = read();
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const published = db.posts.filter(p => p.status === 'published' && !p.deleted_at).length;
  const drafts = db.posts.filter(p => p.status === 'draft' && !p.deleted_at).length;
  const thisMonthPosts = db.posts.filter(p => !p.deleted_at && (p.created_at || '').startsWith(thisMonth)).length;
  const recent = db.posts.filter(p => !p.deleted_at).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, 5);
  res.json({ success: true, data: { published, drafts, categories: db.categories.length, thisMonth: thisMonthPosts, recent } });
});

// ─── SETTINGS ───
app.get('/api/settings', (req, res) => {
  const db = read();
  res.json({ success: true, data: db.settings });
});

app.put('/api/settings', authMiddleware, (req, res) => {
  const db = read();
  Object.assign(db.settings, req.body);
  write(db);
  res.json({ success: true, data: db.settings });
});

// ─── SPA FALLBACK ───
app.get('/admin/*', (req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));

app.listen(PORT, () => console.log(`Blog Fajardo corriendo en http://localhost:${PORT}`));
