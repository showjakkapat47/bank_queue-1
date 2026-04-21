'use strict';

const express  = require('express');
const mysql    = require('mysql2');
const cors     = require('cors');
const util     = require('util');
const bcrypt   = require('bcrypt');
const path     = require('path');
const line     = require('@line/bot-sdk');
const cron     = require('node-cron');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── LINE Client ───────────────────────────────────────────────────
const client = new line.Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.LINE_CHANNEL_SECRET,
});

// ── MySQL ─────────────────────────────────────────────────────────
const db = mysql.createConnection({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
const query = util.promisify(db.query).bind(db);

db.connect(err => {
  if (err) { console.error('❌ DB connection failed:', err.message); return; }
  console.log('✅ Database connected');
  cleanupStaleQueues();
});

// ── Static ────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'kiosk.html')));

// ══════════════════════════════════════════════════════════════════
// KIOSK APIs
// ══════════════════════════════════════════════════════════════════

app.get('/api/kiosk/init', async (req, res) => {
  try {
    const shops = await query(`SELECT * FROM shops WHERE status = 'open' LIMIT 1`);
    if (!shops.length) return res.status(404).json({ success: false, error: 'No active shop found' });

    const shop = shops[0];
    const currentTime = new Date().toTimeString().slice(0, 5);
    const isOpen = currentTime >= shop.open_time && currentTime <= shop.close_time;

    const [stats] = await query(
      `SELECT COUNT(*) as total_waiting, COUNT(CASE WHEN status='in_progress' THEN 1 END) as in_service
       FROM queues WHERE shop_id=? AND status IN ('waiting','called','in_progress')`, [shop.shop_id]
    );

    res.json({
      success: true,
      shop: { ...shop, is_open: isOpen },
      system_status: {
        total_waiting_queues: parseInt(stats.total_waiting) || 0,
        in_service_queues:    parseInt(stats.in_service)    || 0,
      },
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/kiosk/categories', async (req, res) => {
  try {
    const { shop_id, lang = 'th' } = req.query;
    if (!shop_id) return res.status(400).json({ success: false, error: 'shop_id is required' });

    const iconMap = { 1:'fa-solid fa-money-bill-wave', 2:'fa-solid fa-file-invoice',
      3:'fa-solid fa-earth-americas', 4:'fa-solid fa-credit-card', 5:'fa-solid fa-chart-column',
      6:'fa-solid fa-chart-line', 7:'fa-solid fa-money-check-dollar', 8:'fa-solid fa-ellipsis',
      9:'fa-solid fa-clipboard-list', 10:'fa-solid fa-globe' };

    const categories = await query(
      `SELECT * FROM categories WHERE shop_id=? AND is_active=TRUE ORDER BY display_order ASC`, [shop_id]
    );
    const counts = await query(
      `SELECT category_id, COUNT(*) as waiting_count FROM queues WHERE shop_id=? AND status='waiting' GROUP BY category_id`, [shop_id]
    );
    const countMap = {};
    counts.forEach(r => { countMap[r.category_id] = r.waiting_count; });

    const result = categories.map(cat => {
      const waiting_count = countMap[cat.category_id] || 0;
      return {
        category_id:           cat.category_id,
        category_name:         lang==='en' ? (cat.category_name_en||cat.category_name) : lang==='zh' ? (cat.category_name_zh||cat.category_name) : cat.category_name,
        category_code:         cat.category_code,
        queue_prefix:          cat.queue_prefix,
        icon:                  iconMap[cat.category_id] || '💰',
        description:           lang==='en' ? (cat.description_en||cat.description) : lang==='zh' ? (cat.description_zh||cat.description) : cat.description,
        display_order:         cat.display_order,
        estimated_service_time:cat.estimated_service_time,
        waiting_count,
        estimated_wait_time:   cat.estimated_service_time * waiting_count,
        is_active:             cat.is_active,
      };
    });

    res.json({
      success: true,
      title: lang==='en' ? 'Select Service Category' : lang==='zh' ? '选择服务类型' : 'เลือกประเภทบริการ',
      categories: result,
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/kiosk/services', async (req, res) => {
  try {
    const { category_id, shop_id, lang = 'th' } = req.query;
    if (!category_id || !shop_id) return res.status(400).json({ success: false, error: 'category_id and shop_id are required' });

    const [cat] = await query(`SELECT * FROM categories WHERE category_id=? AND shop_id=?`, [category_id, shop_id]);
    if (!cat) return res.status(404).json({ success: false, error: 'Category not found' });

    const services = await query(
      `SELECT * FROM services WHERE category_id=? AND shop_id=? AND is_active=TRUE ORDER BY service_id ASC`,
      [category_id, shop_id]
    );
    const [info] = await query(
      `SELECT COUNT(*) as current_waiting FROM queues WHERE category_id=? AND shop_id=? AND status='waiting'`,
      [category_id, shop_id]
    );

    const avg = services.length ? services.reduce((s, sv) => s + sv.estimated_time, 0) / services.length : 10;

    res.json({
      success: true,
      category: {
        category_id: cat.category_id,
        category_name: lang==='en' ? (cat.category_name_en||cat.category_name) : lang==='zh' ? (cat.category_name_zh||cat.category_name) : cat.category_name,
        queue_prefix: cat.queue_prefix,
      },
      services: services.map(s => ({
        service_id:   s.service_id,
        service_name: lang==='en' ? (s.service_name_en||s.service_name) : lang==='zh' ? (s.service_name_zh||s.service_name) : s.service_name,
        service_code: s.service_code,
        description:  lang==='en' ? (s.description_en||s.description) : lang==='zh' ? (s.description_zh||s.description) : s.description,
        estimated_time: s.estimated_time,
        is_active: s.is_active,
      })),
      waiting_info: {
        current_waiting:     info.current_waiting,
        estimated_wait_time: Math.round(avg * info.current_waiting),
      },
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// QUEUE APIs
// ══════════════════════════════════════════════════════════════════

app.post('/api/queues', async (req, res) => {
  try {
    const { shop_id, service_id, category_id, device_id, customer_phone, priority = 0, line_user_id } = req.body;
    if (!shop_id || !service_id || !category_id)
      return res.status(400).json({ success: false, error: 'Missing required fields' });

    const [cat] = await query(`SELECT queue_prefix, category_name FROM categories WHERE category_id=?`, [category_id]);
    if (!cat) return res.status(404).json({ success: false, error: 'Category not found' });

    const { queue_prefix, category_name } = cat;

    // หาเลขคิวล่าสุด
    const [lastQ]  = await query(`SELECT queue_number FROM queues WHERE shop_id=? AND queue_prefix=? AND DATE(created_at)=CURDATE() ORDER BY queue_number DESC LIMIT 1`, [shop_id, queue_prefix]);
    const [lastH]  = await query(`SELECT queue_number FROM queue_history WHERE shop_id=? AND queue_prefix=? AND DATE(created_at)=CURDATE() ORDER BY queue_number DESC LIMIT 1`, [shop_id, queue_prefix]);

    let lastNum = 0;
    const parseNum = qn => parseInt(qn?.substring(queue_prefix.length), 10) || 0;
    if (lastQ) lastNum = Math.max(lastNum, parseNum(lastQ.queue_number));
    if (lastH) lastNum = Math.max(lastNum, parseNum(lastH.queue_number));

    const queue_number = queue_prefix + String(lastNum + 1).padStart(3, '0');

    const exist = await query(`SELECT queue_id FROM queues WHERE shop_id=? AND queue_number=?`, [shop_id, queue_number]);
    if (exist.length) return res.status(409).json({ success: false, error: `คิว ${queue_number} มีอยู่แล้ว` });

    const [waitInfo] = await query(`SELECT COUNT(*) as count FROM queues WHERE category_id=? AND status='waiting'`, [category_id]);
    const [svcInfo]  = await query(`SELECT estimated_time FROM services WHERE service_id=?`, [service_id]);
    const estimated_wait_time = (svcInfo?.estimated_time || 10) * waitInfo.count;

    const result = await query(
      `INSERT INTO queues (queue_number,queue_prefix,shop_id,service_id,category_id,device_id,customer_phone,line_user_id,status,estimated_wait_time,priority,created_at)
       VALUES (?,?,?,?,?,?,?,?,'waiting',?,?,NOW())`,
      [queue_number, queue_prefix, shop_id, service_id, category_id, device_id||null, customer_phone||null, line_user_id||null, estimated_wait_time, priority]
    );

    const [shop]    = await query(`SELECT shop_name FROM shops WHERE shop_id=?`, [shop_id]);
    const [service] = await query(`SELECT service_name FROM services WHERE service_id=?`, [service_id]);

    res.status(201).json({
      success: true,
      queue: {
        queue_id: result.insertId, queue_number, queue_prefix, status: 'waiting',
        category_name, service_name: service?.service_name || '',
        ahead_count: waitInfo.count, estimated_wait_time,
      },
      print_ticket: {
        queue_number, shop_name: shop?.shop_name || '',
        service_name: service?.service_name || '', category_name,
        date: new Date().toLocaleDateString('th-TH', { year:'numeric', month:'long', day:'numeric' }),
        time: new Date().toLocaleTimeString('th-TH', { hour:'2-digit', minute:'2-digit' }),
      },
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/queue/status/:number', async (req, res) => {
  try {
    const { number } = req.params;
    const { shop_id } = req.query;
    if (!shop_id) return res.status(400).json({ success: false, error: 'shop_id is required' });

    const [q] = await query(
      `SELECT q.*, srv.service_name, cat.category_name, c.counter_name,
        CONCAT(s.first_name,' ',s.last_name) as staff_name,
        TIMESTAMPDIFF(MINUTE,q.created_at,NOW()) as waiting_minutes
       FROM queues q
       LEFT JOIN services srv ON q.service_id=srv.service_id
       LEFT JOIN categories cat ON q.category_id=cat.category_id
       LEFT JOIN counters c ON q.counter_id=c.counter_id
       LEFT JOIN staff s ON q.staff_id=s.staff_id
       WHERE q.queue_number=? AND q.shop_id=?`, [number, shop_id]
    );
    if (!q) return res.status(404).json({ success: false, error: 'Queue not found' });

    const [ahead] = await query(
      `SELECT COUNT(*) as ahead_count FROM queues WHERE category_id=? AND status='waiting' AND created_at<?`,
      [q.category_id, q.created_at]
    );
    const statusTextMap = { waiting:'กำลังรอเรียก', called:'ถูกเรียกแล้ว', recalled:'เรียกซ้ำ', in_progress:'กำลังให้บริการ', on_hold:'พักคิว' };

    res.json({
      success: true,
      queue_number:    q.queue_number,
      status:          q.status,
      status_text:     statusTextMap[q.status] || q.status,
      ahead_count:     q.status === 'waiting' ? ahead.ahead_count : null,
      service_name:    q.service_name,
      category_name:   q.category_name,
      counter_name:    q.counter_name,
      staff_name:      q.staff_name,
      waiting_minutes: q.waiting_minutes,
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/queues/waiting', async (req, res) => {
  try {
    const { shop_id } = req.query;
    if (!shop_id) return res.status(400).json({ success: false, error: 'shop_id is required' });

    const queues = await query(
      `SELECT q.queue_id, q.queue_number, q.queue_prefix, q.status, q.priority,
        q.customer_phone, q.estimated_wait_time, q.created_at,
        q.first_called_at, q.recalled_at, q.started_at, q.recall_count, q.counter_id,
        c.category_name, s.service_name,
        CASE WHEN q.priority=0 THEN 'ปกติ' WHEN q.priority=1 THEN 'ผู้สูงอายุ/คนพิการ' WHEN q.priority=2 THEN 'VIP' ELSE 'อื่นๆ' END as priority_text,
        TIMESTAMPDIFF(MINUTE,q.created_at,NOW()) as waiting_time,
        ct.counter_name, ct.counter_number,
        st.first_name as staff_name, st.staff_id
       FROM queues q
       LEFT JOIN categories c  ON q.category_id=c.category_id
       LEFT JOIN services s    ON q.service_id=s.service_id
       LEFT JOIN counters ct   ON q.counter_id=ct.counter_id
       LEFT JOIN staff st      ON q.staff_id=st.staff_id
       WHERE q.shop_id=?
         AND q.status IN ('waiting','called','recalled','in_progress','on_hold')
         AND DATE(CONVERT_TZ(q.created_at,'+00:00','+07:00'))=DATE(CONVERT_TZ(NOW(),'+00:00','+07:00'))
       ORDER BY q.priority DESC, q.created_at ASC`, [shop_id]
    );
    res.json({ success: true, waiting_queues: queues, total_count: queues.length });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/queues/:id/call', async (req, res) => {
  try {
    const { id } = req.params;
    const { counter_id, staff_id } = req.body;
    if (!counter_id || !staff_id) return res.status(400).json({ success: false, error: 'counter_id and staff_id are required' });

    // เช็คว่า counter มีคิวอยู่แล้วหรือไม่
    const [active] = await query(
      `SELECT queue_id, queue_number, status FROM queues WHERE counter_id=? AND status IN ('called','recalled','in_progress') LIMIT 1`, [counter_id]
    );
    if (active) return res.status(400).json({ success: false, error: 'Counter already has an active queue', message: `มีคิว ${active.queue_number} อยู่แล้ว` });

    const [queue] = await query(`SELECT * FROM queues WHERE queue_id=?`, [id]);
    if (!queue) return res.status(404).json({ success: false, error: 'Queue not found' });
    if (queue.status !== 'waiting') return res.status(400).json({ success: false, error: 'Queue is not waiting' });

    const [counter] = await query(`SELECT category_id FROM counters WHERE counter_id=?`, [counter_id]);
    if (!counter) return res.status(404).json({ success: false, error: 'Counter not found' });

    // ข้ามเช็ค category ถ้าคิวถูกโอนมาที่ counter นี้โดยตรง
    const isTransferred = queue.counter_id && String(queue.counter_id) === String(counter_id);
    if (!isTransferred && counter.category_id !== null && counter.category_id !== queue.category_id)
      return res.status(400).json({ success: false, error: 'Counter does not accept this category' });

    await query(`UPDATE queues SET status='called', counter_id=?, staff_id=?, first_called_at=NOW() WHERE queue_id=?`, [counter_id, staff_id, id]);
    await query(`UPDATE counters SET counter_status='busy', current_queue_id=?, current_staff_id=? WHERE counter_id=?`, [id, staff_id, counter_id]);

    const [info] = await query(
      `SELECT q.queue_number, c.counter_name, CONCAT(s.first_name,' ',s.last_name) as staff_name
       FROM queues q JOIN counters c ON q.counter_id=c.counter_id JOIN staff s ON q.staff_id=s.staff_id
       WHERE q.queue_id=?`, [id]
    );

    // LINE Push Notification
    if (queue.line_user_id?.startsWith('U')) {
      try {
        const LIFF_ID = process.env.LIFF_ID || '2007943872-gimLRRti';
        await client.pushMessage(queue.line_user_id, {
          type: 'flex',
          altText: `🔔 ถูกเรียกแล้ว! คิว ${info.queue_number} — ไปที่ ${info.counter_name}`,
          contents: {
            type: 'bubble',
            header: { type:'box', layout:'vertical', backgroundColor:'#c0392b', paddingAll:'16px',
              contents: [{ type:'text', text:'🔔 ถูกเรียกแล้ว!', color:'#ffffff', weight:'bold', size:'xl' }] },
            body: { type:'box', layout:'vertical', spacing:'md', contents: [
              { type:'box', layout:'vertical', backgroundColor:'#f8f9fa', paddingAll:'14px',
                contents: [{ type:'text', text:'หมายเลขคิว', size:'xs', color:'#999', align:'center' },
                           { type:'text', text:info.queue_number, size:'xxl', weight:'bold', color:'#138853', align:'center' }] },
              { type:'box', layout:'vertical', backgroundColor:'#fdecea', paddingAll:'12px',
                contents: [{ type:'text', text:'📍 กรุณาไปที่', size:'xs', color:'#999', align:'center' },
                           { type:'text', text:info.counter_name, size:'xl', weight:'bold', color:'#c0392b', align:'center' }] },
              { type:'text', text:'โปรดรีบมารับบริการ หากไม่มาจะถูกเรียกซ้ำ', size:'sm', color:'#c0392b', align:'center', wrap:true },
            ]},
            footer: { type:'box', layout:'vertical', paddingAll:'12px',
              contents: [{ type:'button', action:{ type:'uri', label:'📱 ดูรายละเอียด', uri:`https://liff.line.me/${LIFF_ID}?q=${info.queue_number}` }, style:'primary', color:'#c0392b', height:'sm' }] },
          },
        });
      } catch (e) { console.error('❌ Push error:', e.message); }
    }

    res.json({ success: true, queue: { queue_id: parseInt(id), queue_number: info.queue_number, status: 'called', counter_name: info.counter_name } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/queues/:id/recall', async (req, res) => {
  try {
    const { id } = req.params;
    const { staff_id } = req.body;
    if (!staff_id) return res.status(400).json({ success: false, error: 'staff_id is required' });

    const [queue] = await query(`SELECT * FROM queues WHERE queue_id=?`, [id]);
    if (!queue) return res.status(404).json({ success: false, error: 'Queue not found' });
    if (!['called','recalled'].includes(queue.status)) return res.status(400).json({ success: false, error: 'Invalid status' });

    const maxRecall = 3;
    if (queue.recall_count >= maxRecall) return res.status(400).json({ success: false, error: `Maximum recall (${maxRecall}) reached` });

    const newCount = queue.recall_count + 1;
    await query(`UPDATE queues SET status='recalled', recall_count=?, recalled_at=NOW() WHERE queue_id=?`, [newCount, id]);

    const [info] = await query(
      `SELECT q.queue_number, c.counter_name FROM queues q LEFT JOIN counters c ON q.counter_id=c.counter_id WHERE q.queue_id=?`, [id]
    );

    res.json({ success: true, queue: { queue_number: info.queue_number, status: 'recalled', recall_count: newCount, max_recall: maxRecall } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/queues/:id/start', async (req, res) => {
  try {
    const { id } = req.params;
    const { staff_id } = req.body;
    if (!staff_id) return res.status(400).json({ success: false, error: 'staff_id is required' });

    const [queue] = await query(`SELECT * FROM queues WHERE queue_id=?`, [id]);
    if (!queue) return res.status(404).json({ success: false, error: 'Queue not found' });
    if (!['called','recalled'].includes(queue.status)) return res.status(400).json({ success: false, error: 'Invalid status' });

    await query(`UPDATE queues SET status='in_progress', started_at=NOW(), staff_id=? WHERE queue_id=?`, [staff_id, id]);
    if (queue.counter_id)
      await query(`UPDATE counters SET counter_status='busy', current_queue_id=?, current_staff_id=? WHERE counter_id=?`, [id, staff_id, queue.counter_id]);

    res.json({ success: true, message: 'Service started' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/queues/:id/hold', async (req, res) => {
  try {
    const { id } = req.params;
    const { staff_id, hold_reason } = req.body;
    if (!staff_id) return res.status(400).json({ success: false, error: 'staff_id is required' });

    const [queue] = await query(`SELECT * FROM queues WHERE queue_id=?`, [id]);
    if (!queue) return res.status(404).json({ success: false, error: 'Queue not found' });
    if (queue.status !== 'in_progress') return res.status(400).json({ success: false, error: 'Queue not in progress' });

    await query(`UPDATE queues SET status='on_hold', on_hold_at=NOW(), notes=? WHERE queue_id=?`, [hold_reason||'พักคิวชั่วคราว', id]);
    if (queue.counter_id)
      await query(`UPDATE counters SET counter_status='available', current_queue_id=NULL, current_staff_id=NULL WHERE counter_id=?`, [queue.counter_id]);

    res.json({ success: true, message: 'Queue on hold' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/queues/:id/resume', async (req, res) => {
  try {
    const { id } = req.params;
    const { staff_id, counter_id } = req.body;
    if (!staff_id || !counter_id) return res.status(400).json({ success: false, error: 'staff_id and counter_id are required' });

    const [queue] = await query(`SELECT * FROM queues WHERE queue_id=?`, [id]);
    if (!queue) return res.status(404).json({ success: false, error: 'Queue not found' });
    if (queue.status !== 'on_hold') return res.status(400).json({ success: false, error: 'Queue not on hold' });

    const [counter] = await query(`SELECT counter_status FROM counters WHERE counter_id=?`, [counter_id]);
    if (!counter) return res.status(404).json({ success: false, error: 'Counter not found' });
    if (counter.counter_status === 'busy') return res.status(400).json({ success: false, error: 'Counter is busy' });

    await query(`UPDATE queues SET status='in_progress', counter_id=?, staff_id=?, resumed_at=NOW() WHERE queue_id=?`, [counter_id, staff_id, id]);
    await query(`UPDATE counters SET counter_status='busy', current_queue_id=?, current_staff_id=? WHERE counter_id=?`, [id, staff_id, counter_id]);

    res.json({ success: true, message: 'Queue resumed' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/queues/:id/complete', async (req, res) => {
  try {
    const { id } = req.params;
    const { staff_id, service_notes } = req.body;
    if (!staff_id) return res.status(400).json({ success: false, error: 'staff_id is required' });

    const [queue] = await query(
      `SELECT q.*, TIMESTAMPDIFF(MINUTE,q.created_at,q.first_called_at) as actual_wait_time,
        TIMESTAMPDIFF(MINUTE,q.started_at,NOW()) as service_duration,
        TIMESTAMPDIFF(MINUTE,q.created_at,NOW()) as total_time
       FROM queues q WHERE queue_id=?`, [id]
    );
    if (!queue) return res.status(404).json({ success: false, error: 'Queue not found' });
    if (queue.status !== 'in_progress') return res.status(400).json({ success: false, error: 'Queue not in progress' });

    await query(
      `INSERT INTO queue_history (queue_id,queue_number,queue_prefix,shop_id,service_id,category_id,counter_id,staff_id,device_id,customer_phone,final_status,created_at,first_called_at,recalled_at,started_at,on_hold_at,resumed_at,completed_at,actual_wait_time,service_duration,on_hold_duration,total_time,priority,recall_count,notes,cancellation_reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,'completed',?,?,?,?,?,?,NOW(),?,?,?,?,?,?,?,NULL)`,
      [queue.queue_id,queue.queue_number,queue.queue_prefix,queue.shop_id,queue.service_id,queue.category_id,queue.counter_id,staff_id,queue.device_id,queue.customer_phone,queue.created_at,queue.first_called_at,queue.recalled_at,queue.started_at,queue.on_hold_at,queue.resumed_at,queue.actual_wait_time,queue.service_duration,0,queue.total_time,queue.priority,queue.recall_count||0,service_notes||queue.notes]
    );
    await query(`DELETE FROM queues WHERE queue_id=?`, [id]);
    if (queue.counter_id)
      await query(`UPDATE counters SET counter_status='available', current_queue_id=NULL, current_staff_id=NULL WHERE counter_id=?`, [queue.counter_id]);

    res.json({ success: true, message: 'Queue completed', queue_number: queue.queue_number });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/queues/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const { staff_id, cancellation_reason } = req.body;
    if (!staff_id) return res.status(400).json({ success: false, error: 'staff_id is required' });

    const [queue] = await query(
      `SELECT q.*, TIMESTAMPDIFF(MINUTE,q.created_at,q.first_called_at) as wait_time, TIMESTAMPDIFF(MINUTE,q.created_at,NOW()) as total_time FROM queues q WHERE queue_id=?`, [id]
    );
    if (!queue) return res.status(404).json({ success: false, error: 'Queue not found' });
    if (queue.status === 'in_progress') return res.status(400).json({ success: false, error: 'Cannot cancel in-progress queue' });

    await query(
      `INSERT INTO queue_history (queue_id,queue_number,queue_prefix,shop_id,service_id,category_id,counter_id,staff_id,device_id,customer_phone,final_status,created_at,first_called_at,recalled_at,actual_wait_time,total_time,priority,recall_count,notes,cancellation_reason,cancelled_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'cancelled',?,?,?,?,?,?,?,?,?,NOW())`,
      [queue.queue_id,queue.queue_number,queue.queue_prefix,queue.shop_id,queue.service_id,queue.category_id,queue.counter_id||null,staff_id,queue.device_id||null,queue.customer_phone||null,queue.created_at,queue.first_called_at||null,queue.recalled_at||null,queue.wait_time||null,queue.total_time||null,queue.priority||0,queue.recall_count||0,queue.notes||null,cancellation_reason||'ลูกค้าไม่มา']
    );
    await query(`DELETE FROM queues WHERE queue_id=?`, [id]);
    if (queue.counter_id)
      await query(`UPDATE counters SET counter_status='available', current_queue_id=NULL, current_staff_id=NULL WHERE counter_id=?`, [queue.counter_id]);

    res.json({ success: true, message: 'Queue cancelled', queue_number: queue.queue_number });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/queues/:id/transfer', async (req, res) => {
  try {
    const { id } = req.params;
    const { new_counter_id, new_staff_id, new_category_id, new_service_id } = req.body;
    if (!new_counter_id || !new_staff_id) return res.status(400).json({ success: false, error: 'new_counter_id and new_staff_id are required' });

    const [queue] = await query(
      `SELECT q.*, oc.counter_name as old_counter_name, cat.category_name
       FROM queues q LEFT JOIN counters oc ON q.counter_id=oc.counter_id LEFT JOIN categories cat ON q.category_id=cat.category_id
       WHERE q.queue_id=?`, [id]
    );
    if (!queue) return res.status(404).json({ success: false, error: 'Queue not found' });
    if (!['called','in_progress','on_hold'].includes(queue.status))
      return res.status(400).json({ success: false, error: 'Invalid status for transfer' });

    const [newCounter] = await query(
      `SELECT ct.*, c.category_name as counter_category_name FROM counters ct LEFT JOIN categories c ON ct.category_id=c.category_id WHERE ct.counter_id=?`, [new_counter_id]
    );
    if (!newCounter) return res.status(404).json({ success: false, error: 'New counter not found' });

    const [newStaff] = await query(`SELECT staff_id FROM staff WHERE staff_id=?`, [new_staff_id]);
    if (!newStaff) return res.status(404).json({ success: false, error: 'New staff not found' });

    await query(
      `UPDATE queues SET counter_id=?, category_id=COALESCE(?,category_id), service_id=COALESCE(?,service_id),
       staff_id=NULL, status='waiting', first_called_at=NULL, created_at=NOW(),
       notes=CONCAT(COALESCE(notes,''),'\n[โอน] จาก ${queue.old_counter_name||'เคาน์เตอร์เดิม'}')
       WHERE queue_id=?`,
      [new_counter_id, new_category_id||null, new_service_id||null, id]
    );
    if (queue.counter_id)
      await query(`UPDATE counters SET counter_status='available', current_queue_id=NULL, current_staff_id=NULL WHERE counter_id=?`, [queue.counter_id]);

    res.json({
      success: true,
      message: `โอนคิว ${queue.queue_number} ไปรอที่ ${newCounter.counter_name}`,
      queue: { queue_id: parseInt(id), queue_number: queue.queue_number, status: 'waiting', transfer_to: { counter_name: newCounter.counter_name } },
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// LINE LIFF
app.get('/api/queues/by-line-user', async (req, res) => {
  try {
    const { line_user_id, shop_id } = req.query;
    if (!line_user_id) return res.status(400).json({ success: false, error: 'line_user_id required' });

    const [queue] = await query(
      `SELECT q.queue_id, q.queue_number, q.status, q.category_id,
        c.category_name, s.service_name,
        TIMESTAMPDIFF(MINUTE,q.created_at,NOW()) as waiting_minutes,
        (SELECT COUNT(*) FROM queues q2 WHERE q2.category_id=q.category_id AND q2.status='waiting' AND q2.created_at<q.created_at) as ahead_count,
        ct.counter_name
       FROM queues q
       LEFT JOIN categories c ON q.category_id=c.category_id
       LEFT JOIN services s ON q.service_id=s.service_id
       LEFT JOIN counters ct ON q.counter_id=ct.counter_id
       WHERE q.line_user_id=? AND q.shop_id=? AND q.status IN ('waiting','called','recalled','in_progress','on_hold')
       LIMIT 1`, [line_user_id, shop_id||1]
    );
    res.json({ success: true, queue: queue || null });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/queues/cancel-by-line', async (req, res) => {
  try {
    const { line_user_id, shop_id } = req.body;
    if (!line_user_id) return res.status(400).json({ success: false, error: 'line_user_id required' });

    const [q] = await query(
      `SELECT * FROM queues WHERE line_user_id=? AND shop_id=? AND status IN ('waiting','called','recalled','in_progress','on_hold')`,
      [line_user_id, shop_id||1]
    );
    if (!q) return res.status(404).json({ success: false, error: 'ไม่พบคิว' });

    await query(
      `INSERT INTO queue_history (queue_id,queue_number,queue_prefix,shop_id,service_id,category_id,customer_phone,final_status,created_at,cancelled_at,cancellation_reason)
       VALUES (?,?,?,?,?,?,?,'cancelled',?,NOW(),'ยกเลิกผ่าน LINE LIFF')`,
      [q.queue_id,q.queue_number,q.queue_prefix,shop_id||1,q.service_id,q.category_id,q.customer_phone,q.created_at]
    );
    await query(`DELETE FROM queues WHERE queue_id=?`, [q.queue_id]);

    res.json({ success: true, queue_number: q.queue_number });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// DISPLAY API
// ══════════════════════════════════════════════════════════════════

app.get('/api/display/current', async (req, res) => {
  try {
    const { shop_id } = req.query;
    if (!shop_id) return res.status(400).json({ success: false, error: 'shop_id is required' });

    const nowServing = await query(
      `SELECT q.queue_id, q.queue_number, q.status, q.recall_count, c.counter_name, c.counter_number, cat.category_name, q.first_called_at
       FROM queues q LEFT JOIN counters c ON q.counter_id=c.counter_id LEFT JOIN categories cat ON q.category_id=cat.category_id
       WHERE q.shop_id=? AND q.status IN ('called','recalled','in_progress') ORDER BY q.first_called_at DESC LIMIT 10`, [shop_id]
    );
    const waitingSummary = await query(
      `SELECT cat.queue_prefix, cat.category_name, COUNT(*) as waiting_count
       FROM queues q JOIN categories cat ON q.category_id=cat.category_id
       WHERE q.shop_id=? AND q.status='waiting' GROUP BY cat.category_id, cat.queue_prefix, cat.category_name`, [shop_id]
    );

    res.json({
      success: true,
      now_serving: nowServing.map(q => ({
        ...q,
        status_text: q.status==='called' ? 'กำลังเรียก' : q.status==='recalled' ? 'เรียกซ้ำ' : 'กำลังให้บริการ',
      })),
      waiting_summary: waitingSummary,
      total_now_serving: nowServing.length,
      total_waiting: waitingSummary.reduce((s, w) => s + w.waiting_count, 0),
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// STAFF / COUNTER APIs
// ══════════════════════════════════════════════════════════════════

app.post('/api/staff/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, error: 'Username and password are required' });

    const [staff] = await query(`SELECT * FROM staff WHERE username=? AND is_active=1`, [username]);
    if (!staff) return res.status(401).json({ success: false, error: 'Invalid username or password' });

    const valid = await bcrypt.compare(password, staff.password);
    if (!valid) return res.status(401).json({ success: false, error: 'Invalid username or password' });

    delete staff.password;
    res.json({ success: true, staff });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/counters', async (req, res) => {
  try {
    const { shop_id } = req.query;
    const counters = await query(
      `SELECT counter_id, counter_name, counter_number, counter_status, category_id, current_queue_id, current_staff_id, is_active
       FROM counters WHERE shop_id=? AND is_active=1 ORDER BY counter_number ASC`, [shop_id||1]
    );
    res.json({ success: true, counters });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/counters/:id/login', async (req, res) => {
  try {
    const { id } = req.params;
    const { staff_id } = req.body;
    if (!staff_id) return res.status(400).json({ success: false, error: 'staff_id is required' });

    const [counter] = await query(`SELECT counter_status FROM counters WHERE counter_id=?`, [id]);
    if (!counter) return res.status(404).json({ success: false, error: 'Counter not found' });
    if (counter.counter_status === 'busy') return res.status(400).json({ success: false, error: 'Counter already in use' });

    await query(`UPDATE counters SET counter_status='busy', current_staff_id=? WHERE counter_id=?`, [staff_id, id]);
    res.json({ success: true, message: 'Counter locked' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/counters/:id/logout', async (req, res) => {
  try {
    const { id } = req.params;
    const [active] = await query(`SELECT COUNT(*) as count FROM queues WHERE counter_id=? AND status IN ('called','recalled','in_progress','on_hold')`, [id]);
    if (active.count > 0) return res.status(400).json({ success: false, error: `ยังมี ${active.count} คิวที่ยังไม่เสร็จสิ้น` });

    await query(`UPDATE counters SET counter_status='available', current_staff_id=NULL, current_queue_id=NULL WHERE counter_id=?`, [id]);
    res.json({ success: true, message: 'Counter unlocked' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/counters/:id/pause', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const [active] = await query(`SELECT COUNT(*) as count FROM queues WHERE counter_id=? AND status IN ('called','recalled','in_progress')`, [id]);
    if (active.count > 0) return res.status(400).json({ success: false, error: 'มีคิวที่กำลังให้บริการอยู่' });

    await query(`UPDATE counters SET counter_status='paused', pause_reason=? WHERE counter_id=?`, [reason||'พักชั่วคราว', id]);
    res.json({ success: true, message: 'พักเคาน์เตอร์สำเร็จ' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/counters/:id/unpause', async (req, res) => {
  try {
    const { id } = req.params;
    await query(`UPDATE counters SET counter_status='busy', pause_reason=NULL WHERE counter_id=?`, [id]);
    res.json({ success: true, message: 'เปิดเคาน์เตอร์สำเร็จ' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// PRINTER APIs
// ══════════════════════════════════════════════════════════════════

const printerService = require('./printerService');

app.post('/api/printer/print', async (req, res) => {
  try {
    let printData = req.body;
    const printLang = req.body.lang || 'th';

    if (req.body.queue_id && !req.body.queue_number) {
      const [row] = await query(
        `SELECT q.queue_number, q.estimated_wait_time, s.shop_name,
          c.category_name, c.category_name_en, sv.service_name, sv.service_name_en,
          (SELECT COUNT(*) FROM queues q2 WHERE q2.category_id=q.category_id AND q2.status='waiting' AND q2.created_at<q.created_at) AS ahead_count
         FROM queues q JOIN shops s ON q.shop_id=s.shop_id JOIN categories c ON q.category_id=c.category_id JOIN services sv ON q.service_id=sv.service_id
         WHERE q.queue_id=?`, [req.body.queue_id]
      );
      if (!row) return res.status(404).json({ success: false, error: 'Queue not found' });

      const isEn = printLang === 'en' || printLang === 'zh';
      printData = {
        queue_number:        row.queue_number,
        shop_name:           row.shop_name,
        category_name:       isEn ? (row.category_name_en||row.category_name) : row.category_name,
        service_name:        isEn ? (row.service_name_en ||row.service_name)  : row.service_name,
        date:                new Date().toLocaleDateString(isEn?'en-GB':'th-TH', { year:'numeric', month:'long', day:'numeric' }),
        time:                new Date().toLocaleTimeString(isEn?'en-GB':'th-TH', { hour:'2-digit', minute:'2-digit' }),
        ahead_count:         row.ahead_count,
        estimated_wait_time: row.estimated_wait_time,
        lang:                printLang,
      };
    }

    if (!printData.queue_number) return res.status(400).json({ success: false, error: 'queue_number is required' });

    const result = await printerService.printQueueTicket(printData);
    if (result.success) res.json({ success: true, message: result.message });
    else res.status(502).json({ success: false, error: result.error });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/printer/check', async (req, res) => {
  try {
    const result = await printerService.checkPrinter();
    res.status(result.online ? 200 : 503).json(result);
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/printer/test', async (req, res) => {
  try {
    const result = await printerService.testPrinter();
    if (result.success) res.json({ success: true, message: 'Test ticket sent' });
    else res.status(502).json({ success: false, error: result.error });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// ANALYTICS
// ══════════════════════════════════════════════════════════════════

const registerAnalyticsRoutes = require('./analyticsRoutes');
registerAnalyticsRoutes(app, query);

// ══════════════════════════════════════════════════════════════════
// AUTO CLEANUP (ยกเลิกคิวข้ามวัน)
// ══════════════════════════════════════════════════════════════════

async function cleanupStaleQueues() {
  try {
    const stale = await query(
      `SELECT * FROM queues
       WHERE DATE(CONVERT_TZ(created_at,'+00:00','+07:00')) < DATE(CONVERT_TZ(NOW(),'+00:00','+07:00'))
         AND status IN ('waiting','called','recalled','in_progress','on_hold')`
    );
    if (!stale.length) { console.log('✅ No stale queues'); return; }

    for (const q of stale) {
      await query(
        `INSERT IGNORE INTO queue_history (queue_id,queue_number,queue_prefix,shop_id,service_id,category_id,counter_id,staff_id,device_id,customer_phone,final_status,created_at,cancelled_at,cancellation_reason,priority,recall_count,notes)
         VALUES (?,?,?,?,?,?,?,?,?,?,'cancelled',?,NOW(),'ระบบยกเลิกอัตโนมัติข้ามวัน',?,?,?)`,
        [q.queue_id,q.queue_number,q.queue_prefix,q.shop_id,q.service_id,q.category_id,q.counter_id||null,q.staff_id||null,q.device_id||null,q.customer_phone||null,q.created_at,q.priority||0,q.recall_count||0,q.notes||null]
      );
      await query(`DELETE FROM queues WHERE queue_id=?`, [q.queue_id]);
    }
    console.log(`🧹 Cleanup: ยกเลิก ${stale.length} คิวข้ามวัน`);
  } catch (e) { console.error('❌ Cleanup error:', e.message); }
}

cron.schedule('0 0 * * *', cleanupStaleQueues, { timezone: 'Asia/Bangkok' });

// ══════════════════════════════════════════════════════════════════
// LINE PUSH NOTIFICATION CRON
// ══════════════════════════════════════════════════════════════════

cron.schedule('*/30 * * * * *', async () => {
  try {
    const queues = await query(
      `SELECT q.queue_id, q.queue_number, q.line_user_id, q.category_id,
        q.notified_at_10, q.notified_at_6, q.notified_at_3, c.category_name,
        (SELECT COUNT(*) FROM queues q2 WHERE q2.category_id=q.category_id AND q2.status='waiting' AND q2.created_at<q.created_at) as ahead_count
       FROM queues q LEFT JOIN categories c ON q.category_id=c.category_id
       WHERE q.status='waiting' AND q.line_user_id IS NOT NULL AND q.line_user_id LIKE 'U%'`
    );

    for (const q of queues) {
      const ahead = q.ahead_count;
      const lastNotified = q.notified_at_3 || q.notified_at_6 || q.notified_at_10;
      if (lastNotified && (Date.now() - new Date(lastNotified).getTime()) / 60000 < 3) continue;

      let threshold = null;
      if      (ahead <= 3  && !q.notified_at_3)  threshold = 3;
      else if (ahead <= 6  && !q.notified_at_6)  threshold = 6;
      else if (ahead <= 10 && !q.notified_at_10) threshold = 10;
      if (!threshold) continue;

      await sendLiffNotification(q, threshold, ahead);

      const col = threshold === 3 ? 'notified_at_3' : threshold === 6 ? 'notified_at_6' : 'notified_at_10';
      await query(`UPDATE queues SET ${col}=NOW() WHERE queue_id=?`, [q.queue_id]);
    }
  } catch (e) { console.error('❌ Notification cron error:', e.message); }
});

async function sendLiffNotification(queue, threshold, aheadCount) {
  const LIFF_ID = process.env.LIFF_ID || '2007943872-gimLRRti';
  const liffUrl = `https://liff.line.me/${LIFF_ID}?q=${queue.queue_number}`;
  const configs = {
    10: { emoji:'📢', title:'เตรียมตัวมาที่สาขา',  color:'#2980b9', text:'โปรดเตรียมตัวออกเดินทางมาสาขา' },
    6:  { emoji:'🔔', title:'ใกล้ถึงคิวแล้ว!',      color:'#e67e22', text:'โปรดเดินทางมาที่สาขาได้เลย'    },
    3:  { emoji:'⏰', title:'อีกไม่นานถึงคิวคุณ!',  color:'#c0392b', text:'โปรดรอที่สาขาเพื่อรับบริการ'   },
  };
  const c = configs[threshold];

  await client.pushMessage(queue.line_user_id, {
    type: 'flex',
    altText: `${c.emoji} ${c.title} — คิว ${queue.queue_number} เหลืออีก ${aheadCount} คิว`,
    contents: {
      type: 'bubble',
      header: { type:'box', layout:'vertical', backgroundColor:c.color, paddingAll:'16px',
        contents: [{ type:'text', text:`${c.emoji} ${c.title}`, color:'#ffffff', weight:'bold', size:'lg' }] },
      body: { type:'box', layout:'vertical', spacing:'md', contents: [
        { type:'box', layout:'vertical', backgroundColor:'#f8f9fa', paddingAll:'14px',
          contents: [{ type:'text', text:'หมายเลขคิวของคุณ', size:'xs', color:'#999999', align:'center' },
                     { type:'text', text:queue.queue_number, size:'xxl', weight:'bold', color:'#138853', align:'center' }] },
        { type:'box', layout:'horizontal', spacing:'sm', contents: [
          { type:'box', layout:'vertical', flex:1, backgroundColor:'#f0f9f4', paddingAll:'10px',
            contents: [{ type:'text', text:'บริการ', size:'xs', color:'#999', align:'center' },
                       { type:'text', text:queue.category_name, size:'sm', weight:'bold', color:'#333', align:'center', wrap:true }] },
          { type:'box', layout:'vertical', flex:1, backgroundColor:threshold===3?'#fdecea':'#fff3cd', paddingAll:'10px',
            contents: [{ type:'text', text:'คิวข้างหน้า', size:'xs', color:'#999', align:'center' },
                       { type:'text', text:`${aheadCount} คิว`, size:'xl', weight:'bold', color:c.color, align:'center' }] },
        ]},
        { type:'text', text:c.text, size:'sm', color:c.color, weight:'bold', align:'center', wrap:true },
      ]},
      footer: { type:'box', layout:'vertical', paddingAll:'12px',
        contents: [{ type:'button', action:{ type:'uri', label:'📱 เช็คสถานะ / จัดการคิว', uri:liffUrl }, style:'primary', color:'#138853', height:'sm' }] },
    },
  });
  console.log(`📲 Sent @${threshold} → ${queue.line_user_id} (${queue.queue_number})`);
}

// ── Start ─────────────────────────────────────────────────────────
console.log('⏰ Notification cron started');
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));