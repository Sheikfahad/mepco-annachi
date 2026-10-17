const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'annachi2026'; // change this!

const DATA = path.join(__dirname, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const CSV_FILE = path.join(DATA, 'orders.csv');
const JSON_FILE = path.join(DATA, 'orders.json');
fs.mkdirSync(UPLOADS, { recursive: true });

// Server-side price list (never trust prices sent from the browser)
const PRODUCTS = {
  milk: ['Aavin Milk', 32], rice: ['Daawat Basmati Rice', 78],
  maggi: ['Maggi 2-Minute Noodles', 14], cookies: ['Dark Chocolate Cookies', 45],
  'print-bw': ['Black & White Print', 3], 'print-color': ['Colour Print', 10],
  'case-clear': ['Clear Phone Case', 149], 'case-pop': ['Pop Graphic Case', 199]
};

const HEADERS = ['Order ID', 'Customer Name', 'Phone', 'Address', 'Items Purchased',
  'Amount (INR)', 'Note', 'Print Files', 'Order Time'];

// CSV cell: quote everything, and neutralise Excel formula injection
const cell = v => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
};
if (!fs.existsSync(CSV_FILE)) {
  fs.writeFileSync(CSV_FILE, '\ufeff' + HEADERS.map(cell).join(',') + '\r\n'); // BOM so Excel reads UTF-8
}
const readOrders = () => { try { return JSON.parse(fs.readFileSync(JSON_FILE, 'utf8')); } catch { return []; } };

// ---- uploads ----
const ALLOWED = ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.jpg', '.jpeg', '.png'];
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (req, file, cb) =>
      cb(null, crypto.randomBytes(12).toString('hex') + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: 20 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) =>
    ALLOWED.includes(path.extname(file.originalname).toLowerCase())
      ? cb(null, true) : cb(new Error('Only PDF, Word, PowerPoint or image files are allowed.'))
}).array('files', 5);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- place order ----
app.post('/api/orders', (req, res) => {
  upload(req, res, err => {
    const files = req.files || [];
    const discard = () => files.forEach(f => fs.unlink(f.path, () => {}));
    if (err) { discard(); return res.status(400).json({ error: err.message }); }

    const { name = '', phone = '', address = '', note = '' } = req.body;
    let items;
    try { items = JSON.parse(req.body.items || '[]'); } catch { items = []; }

    items = items.filter(i => PRODUCTS[i.id] && Number.isInteger(i.qty) && i.qty > 0 && i.qty <= 1000)
      .map(i => ({ id: i.id, name: PRODUCTS[i.id][0], qty: i.qty, price: PRODUCTS[i.id][1] }));

    if (!name.trim() || !address.trim() || !/^\d{10}$/.test(phone.trim()) || !items.length) {
      discard();
      return res.status(400).json({ error: 'Please enter a valid name, 10-digit phone, address and items.' });
    }
    if (items.some(i => i.id.startsWith('print-')) && !files.length) {
      discard();
      return res.status(400).json({ error: 'Please upload the file you want printed.' });
    }

    const order = {
      id: 'MA-' + crypto.randomInt(100000, 999999),
      name: name.trim().slice(0, 100), phone: phone.trim(),
      address: address.trim().slice(0, 300), note: note.trim().slice(0, 300),
      items, amount: items.reduce((a, i) => a + i.price * i.qty, 0),
      files: files.map(f => ({ original: f.originalname, stored: f.filename })),
      time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
    };

    const row = [order.id, order.name, order.phone, order.address,
      order.items.map(i => `${i.name} x${i.qty}`).join('; '), order.amount, order.note,
      order.files.map(f => `${f.original} (${f.stored})`).join('; '), order.time];
    fs.appendFileSync(CSV_FILE, row.map(cell).join(',') + '\r\n');

    const all = readOrders(); all.unshift(order);
    fs.writeFileSync(JSON_FILE, JSON.stringify(all, null, 2));

    res.json({ ok: true, orderId: order.id, amount: order.amount });
  });
});

// ---- admin ----
const tokens = new Set();
const auth = (req, res, next) => {
  const t = req.get('x-admin-token') || req.query.token;
  return tokens.has(t) ? next() : res.status(401).json({ error: 'Unauthorized' });
};

app.post('/api/admin/login', (req, res) => {
  const a = crypto.createHash('sha256').update(String(req.body.password || '')).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Incorrect password' });
  const token = crypto.randomBytes(24).toString('hex');
  tokens.add(token);
  res.json({ token });
});

app.get('/api/admin/orders', auth, (req, res) => res.json(readOrders()));

app.get('/api/admin/orders.csv', auth, (req, res) =>
  res.download(CSV_FILE, 'mepco-annachi-customer-orders.csv'));

app.get('/api/admin/files/:name', auth, (req, res) => {
  if (!/^[a-f0-9]{24}\.[a-z0-9]+$/.test(req.params.name)) return res.sendStatus(400);
  const file = path.join(UPLOADS, req.params.name);
  if (!fs.existsSync(file)) return res.sendStatus(404);
  const original = readOrders().flatMap(o => o.files || []).find(f => f.stored === req.params.name);
  res.download(file, original ? original.original : req.params.name);
});

app.listen(PORT, () => console.log(`Mepco Annachi running at http://localhost:${PORT}`));
