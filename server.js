require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const supabase = require('./lib/db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fajardo-blog-secret-2025';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

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

function dbError(res, error) {
  console.error('DB error:', error.message);
  res.status(500).json({ success: false, message: error.message });
}

// ─── AUTH ───
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const { data: user, error } = await supabase
    .from('users').select('*').eq('email', email).single();
  if (error || !user) return res.status(401).json({ success: false, message: 'Credenciales incorrectas' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ success: false, message: 'Credenciales incorrectas' });
  await supabase.from('users').update({ last_login: new Date().toISOString() }).eq('email', email);
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ success: true, data: { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } } });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ success: true, data: req.user });
});

// ─── POSTS ───
app.get('/api/posts', async (req, res) => {
  const { category, search, status, page = 1, limit = 12 } = req.query;
  const isAdmin = !!req.headers.authorization;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let query = supabase.from('posts').select('*', { count: 'exact' }).is('deleted_at', null);
  if (!isAdmin) query = query.eq('status', 'published');
  if (category) query = query.or(`category_id.eq.${category},slug.eq.${category}`);
  if (status) query = query.eq('status', status);
  if (search) query = query.or(`title.ilike.%${search}%,excerpt.ilike.%${search}%`);
  query = query.order('published_at', { ascending: false, nullsFirst: false })
               .order('created_at', { ascending: false })
               .range(offset, offset + parseInt(limit) - 1);

  const { data, error, count } = await query;
  if (error) return dbError(res, error);
  res.json({ success: true, data, total: count, page: parseInt(page), pages: Math.ceil(count / parseInt(limit)) });
});

app.get('/api/posts/:id', async (req, res) => {
  const { data: post, error } = await supabase
    .from('posts').select('*').is('deleted_at', null)
    .or(`id.eq.${req.params.id},slug.eq.${req.params.id}`)
    .single();
  if (error || !post) return res.status(404).json({ success: false, message: 'Post no encontrado' });
  if (post.status === 'draft' && !req.headers.authorization) return res.status(404).json({ success: false, message: 'Post no encontrado' });
  await supabase.from('posts').update({ views_count: (post.views_count || 0) + 1 }).eq('id', post.id);
  res.json({ success: true, data: { ...post, views_count: (post.views_count || 0) + 1 } });
});

app.post('/api/posts', authMiddleware, async (req, res) => {
  const { title, content, excerpt, featured_image, category_id, seo_description, status = 'draft' } = req.body;
  if (!title || !content || !category_id) return res.status(400).json({ success: false, message: 'Faltan campos requeridos' });
  const { data: cat, error: catErr } = await supabase.from('categories').select('*').eq('id', category_id).single();
  if (catErr || !cat) return res.status(400).json({ success: false, message: 'Categoría no encontrada' });
  const now = new Date().toISOString();
  const post = {
    id: `post-${uuidv4().slice(0, 8)}`,
    title, slug: slugify(title), content,
    excerpt: excerpt || content.replace(/<[^>]+>/g, '').slice(0, 200) + '...',
    featured_image: featured_image || null,
    category_id, category_name: cat.name, category_color: cat.color,
    author: req.user.name, status,
    created_at: now, updated_at: now,
    published_at: status === 'published' ? now : null,
    seo_description: seo_description || '',
    reading_time_minutes: calcReadingTime(content),
    views_count: 0, deleted_at: null
  };
  const { data, error } = await supabase.from('posts').insert(post).select().single();
  console.log('INSERT result:', JSON.stringify({ data: data?.id, error: error?.message }));
  if (error) return dbError(res, error);
  if (status === 'published') {
    await supabase.from('categories').update({ post_count: (cat.post_count || 0) + 1 }).eq('id', category_id);
  }
  res.status(201).json({ success: true, data });
});

app.put('/api/posts/:id', authMiddleware, async (req, res) => {
  const { data: post, error: fetchErr } = await supabase
    .from('posts').select('*').eq('id', req.params.id).is('deleted_at', null).single();
  if (fetchErr || !post) return res.status(404).json({ success: false, message: 'Post no encontrado' });
  const { title, content, excerpt, featured_image, category_id, seo_description, status } = req.body;
  const update = { updated_at: new Date().toISOString() };
  if (title) { update.title = title; update.slug = slugify(title); }
  if (content) { update.content = content; update.reading_time_minutes = calcReadingTime(content); }
  if (excerpt !== undefined) update.excerpt = excerpt;
  if (featured_image !== undefined) update.featured_image = featured_image;
  if (seo_description !== undefined) update.seo_description = seo_description;
  if (category_id) {
    const { data: cat } = await supabase.from('categories').select('*').eq('id', category_id).single();
    if (cat) { update.category_id = category_id; update.category_name = cat.name; update.category_color = cat.color; }
  }
  if (status) {
    update.status = status;
    if (post.status === 'draft' && status === 'published') update.published_at = new Date().toISOString();
    if (status !== 'published') update.published_at = null;
  }
  const { data, error } = await supabase.from('posts').update(update).eq('id', req.params.id).select().single();
  if (error) return dbError(res, error);
  res.json({ success: true, data });
});

app.delete('/api/posts/:id', authMiddleware, async (req, res) => {
  const { data: post } = await supabase.from('posts').select('id').eq('id', req.params.id).is('deleted_at', null).single();
  if (!post) return res.status(404).json({ success: false, message: 'Post no encontrado' });
  const { error } = await supabase.from('posts').update({ deleted_at: new Date().toISOString() }).eq('id', req.params.id);
  if (error) return dbError(res, error);
  res.json({ success: true, message: 'Post eliminado' });
});

// ─── CATEGORIES ───
app.get('/api/categories', async (req, res) => {
  const { data, error } = await supabase.from('categories').select('*');
  if (error) return dbError(res, error);
  res.json({ success: true, data });
});

app.post('/api/categories', authMiddleware, async (req, res) => {
  const { name, description = '', color = '#888888', icon = '📁' } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'El nombre es requerido' });
  const { data: exists } = await supabase.from('categories').select('id').ilike('name', name).single();
  if (exists) return res.status(400).json({ success: false, message: 'Categoría ya existe' });
  const cat = { id: `cat-${uuidv4().slice(0, 8)}`, name, slug: slugify(name), description, color, icon, post_count: 0 };
  const { data, error } = await supabase.from('categories').insert(cat).select().single();
  if (error) return dbError(res, error);
  res.status(201).json({ success: true, data });
});

app.put('/api/categories/:id', authMiddleware, async (req, res) => {
  const { data: cat } = await supabase.from('categories').select('id').eq('id', req.params.id).single();
  if (!cat) return res.status(404).json({ success: false, message: 'Categoría no encontrada' });
  const { name, description, color, icon } = req.body;
  const update = {};
  if (name) { update.name = name; update.slug = slugify(name); }
  if (description !== undefined) update.description = description;
  if (color) update.color = color;
  if (icon) update.icon = icon;
  const { data, error } = await supabase.from('categories').update(update).eq('id', req.params.id).select().single();
  if (error) return dbError(res, error);
  res.json({ success: true, data });
});

app.delete('/api/categories/:id', authMiddleware, async (req, res) => {
  const { data: cat } = await supabase.from('categories').select('id').eq('id', req.params.id).single();
  if (!cat) return res.status(404).json({ success: false, message: 'Categoría no encontrada' });
  const { data: hasPost } = await supabase.from('posts').select('id').eq('category_id', req.params.id).is('deleted_at', null).limit(1).single();
  if (hasPost) return res.status(400).json({ success: false, message: 'No se puede eliminar: tiene posts asignados' });
  const { error } = await supabase.from('categories').delete().eq('id', req.params.id);
  if (error) return dbError(res, error);
  res.json({ success: true, message: 'Categoría eliminada' });
});

// ─── UPLOAD ───
app.post('/api/upload', authMiddleware, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No se subió ningún archivo' });
  res.json({ success: true, data: { url: `/uploads/${req.file.filename}`, filename: req.file.filename } });
});

// ─── STATS ───
app.get('/api/stats', authMiddleware, async (req, res) => {
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [
    { count: published },
    { count: drafts },
    { count: categories },
    { count: thisMonthPosts },
    { data: recent }
  ] = await Promise.all([
    supabase.from('posts').select('*', { count: 'exact', head: true }).eq('status', 'published').is('deleted_at', null),
    supabase.from('posts').select('*', { count: 'exact', head: true }).eq('status', 'draft').is('deleted_at', null),
    supabase.from('categories').select('*', { count: 'exact', head: true }),
    supabase.from('posts').select('*', { count: 'exact', head: true }).is('deleted_at', null).like('created_at', `${thisMonth}%`),
    supabase.from('posts').select('*').is('deleted_at', null).order('updated_at', { ascending: false }).limit(5)
  ]);
  res.json({ success: true, data: { published, drafts, categories, thisMonth: thisMonthPosts, recent: recent || [] } });
});

// ─── SETTINGS ───
app.get('/api/settings', async (req, res) => {
  const { data, error } = await supabase.from('settings').select('*').eq('id', 'site').single();
  if (error) return dbError(res, error);
  res.json({ success: true, data });
});

app.put('/api/settings', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('settings').upsert({ id: 'site', ...req.body }).select().single();
  if (error) return dbError(res, error);
  res.json({ success: true, data });
});

// ─── SPA FALLBACK ───
app.get('/admin/*', (req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));

app.listen(PORT, () => console.log(`Blog Fajardo corriendo en http://localhost:${PORT}`));
