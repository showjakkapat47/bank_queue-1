'use strict';

// ── Timezone helpers (UTC → +07:00) ──────────────────────────────
const TZ      = "'+07:00'";
const UTC     = "'+00:00'";
const thDate  = col => `DATE(CONVERT_TZ(${col}, ${UTC}, ${TZ}))`;
const thHour  = col => `HOUR(CONVERT_TZ(${col}, ${UTC}, ${TZ}))`;
const thNow   = ()  => `DATE(CONVERT_TZ(NOW(), ${UTC}, ${TZ}))`;

// ── Date filter builder ───────────────────────────────────────────
function buildDateFilter(col, period, start, end) {
  const d = thDate(col);
  const n = thNow();
  switch (period) {
    case 'today':     return { filter: `AND ${d} = ${n}`,                                                    params: [] };
    case 'yesterday': return { filter: `AND ${d} = DATE_SUB(${n}, INTERVAL 1 DAY)`,                         params: [] };
    case 'week':      return { filter: `AND ${d} >= DATE_SUB(${n}, INTERVAL WEEKDAY(${n}) DAY)`,             params: [] };
    case 'custom':    return { filter: `AND ${d} BETWEEN ? AND ?`,                                           params: [start, end] };
    default:          return { filter: `AND ${col} >= DATE_SUB(NOW(), INTERVAL 30 DAY)`,                     params: [] };
  }
}

// ── Formatters ────────────────────────────────────────────────────
const pad      = n => String(n).padStart(2, '0');
const fmtDate  = d => d instanceof Date ? `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` : String(d).slice(0, 10);
const rateClass = r => r >= 90 ? 'excellent' : r >= 75 ? 'good' : r >= 60 ? 'average' : 'poor';
const rateText  = r => r >= 90 ? 'ดีมาก'     : r >= 75 ? 'ดี'  : r >= 60 ? 'พอใช้'  : 'ต้องปรับปรุง';
const utilClass = u => u >= 80 ? 'excellent' : u >= 50 ? 'good' : u >= 20 ? 'average' : 'poor';
const utilText  = u => u >= 80 ? 'ใช้งานสูง' : u >= 50 ? 'ปกติ' : u >= 20 ? 'ต่ำ'   : 'ไม่ได้ใช้';

// ── Register routes ───────────────────────────────────────────────
module.exports = function registerAnalyticsRoutes(app, query) {

  app.get('/api/analytics', async (req, res) => {
    try {
      const { shop_id = 1, period = 'month', start_date, end_date } = req.query;

      const { filter, params } = buildDateFilter('h.created_at', period, start_date, end_date);
      const base = [shop_id, ...params];

      // 1. Overview
      const [ov] = await query(`
        SELECT
          COUNT(*)                                                AS total_queues,
          SUM(h.final_status = 'completed')                      AS completed_queues,
          SUM(h.final_status = 'cancelled')                      AS cancelled_queues,
          ROUND(AVG(h.actual_wait_time), 1)                      AS avg_wait_time,
          ROUND(AVG(h.service_duration), 1)                      AS avg_service_time,
          ROUND(SUM(h.final_status='completed')/COUNT(*)*100, 1) AS completion_rate,
          ROUND(SUM(h.final_status='cancelled')/COUNT(*)*100, 1) AS cancel_rate
        FROM queue_history h
        WHERE h.shop_id = ? ${filter}
      `, base);

      const [activeStaff]   = await query(`SELECT COUNT(DISTINCT staff_id) AS cnt FROM queues WHERE shop_id = ?`, [shop_id]);
      const [activeCounter] = await query(`SELECT COUNT(*) AS cnt FROM counters WHERE shop_id = ? AND is_active = 1 AND counter_status IN ('available','busy')`, [shop_id]);
      const [peak]          = await query(`
        SELECT ${thHour('h.created_at')} AS hr, COUNT(*) AS cnt
        FROM queue_history h WHERE h.shop_id = ? ${filter}
        GROUP BY hr ORDER BY cnt DESC LIMIT 1
      `, base);
      const [prev] = await query(`
        SELECT COUNT(*) AS total, ROUND(AVG(actual_wait_time),1) AS avg_wait
        FROM queue_history
        WHERE shop_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 60 DAY) AND created_at < DATE_SUB(NOW(), INTERVAL 30 DAY)
      `, [shop_id]);

      const queueChange = prev?.total ? Math.round(((ov.total_queues - prev.total) / prev.total) * 100) : 0;
      const waitChange  = prev?.avg_wait && ov.avg_wait_time ? Math.round(((ov.avg_wait_time - prev.avg_wait) / prev.avg_wait) * 100) : 0;

      const overview = {
        total_queues:     ov.total_queues     || 0,
        completed_queues: ov.completed_queues || 0,
        cancelled_queues: ov.cancelled_queues || 0,
        avg_wait_time:    ov.avg_wait_time    || 0,
        avg_service_time: ov.avg_service_time || 0,
        completion_rate:  ov.completion_rate  || 0,
        cancel_rate:      ov.cancel_rate      || 0,
        active_staff:     activeStaff?.cnt    || 0,
        active_counters:  activeCounter?.cnt  || 0,
        peak_hour:        peak ? `${pad(peak.hr)}:00` : '-',
        queue_change:     queueChange,
        wait_time_change: waitChange,
      };

      // 2. Daily trend
      const dailyRows = await query(`
        SELECT ${thDate('h.created_at')} AS day, COUNT(*) AS cnt
        FROM queue_history h WHERE h.shop_id = ? ${filter}
        GROUP BY day ORDER BY day ASC
      `, base);

      const daily = {
        labels: dailyRows.map(r => fmtDate(r.day)),
        values: dailyRows.map(r => r.cnt),
      };

      // 3. Status breakdown
      const statusRows = await query(`
        SELECT h.final_status, COUNT(*) AS cnt
        FROM queue_history h WHERE h.shop_id = ? ${filter}
        GROUP BY h.final_status
      `, base);

      const statusMap = Object.fromEntries(statusRows.map(r => [r.final_status, r.cnt]));
      const status = { completed: statusMap.completed || 0, cancelled: statusMap.cancelled || 0, waiting: statusMap.waiting || 0 };

      // 4. Hourly distribution
      const hourlyRows = await query(`
        SELECT ${thHour('h.created_at')} AS hr, COUNT(*) AS cnt
        FROM queue_history h WHERE h.shop_id = ? ${filter}
        GROUP BY hr ORDER BY hr ASC
      `, base);

      const hourlyMap = Object.fromEntries(hourlyRows.map(r => [r.hr, r.cnt]));
      const hourly = {
        labels: Array.from({ length: 24 }, (_, i) => `${pad(i)}:00`),
        values: Array.from({ length: 24 }, (_, i) => hourlyMap[i] || 0),
      };

      // 5. Service performance
      const serviceRows = await query(`
        SELECT
          c.category_name                                               AS service_name,
          COUNT(*)                                                      AS total_queues,
          ROUND(AVG(h.actual_wait_time), 1)                            AS avg_wait_time,
          ROUND(AVG(h.service_duration), 1)                            AS avg_service_time,
          ROUND(SUM(h.final_status='completed')/COUNT(*)*100, 1)       AS success_rate
        FROM queue_history h
        JOIN categories c ON h.category_id = c.category_id
        WHERE h.shop_id = ? ${filter}
        GROUP BY h.category_id, c.category_name
        ORDER BY total_queues DESC
      `, base);

      const services = serviceRows.map(s => ({
        ...s,
        avg_wait_time:    s.avg_wait_time    || 0,
        avg_service_time: s.avg_service_time || 0,
        success_rate:     s.success_rate     || 0,
        rating_class:     rateClass(s.success_rate || 0),
        rating:           rateText(s.success_rate  || 0),
      }));

      // 6. Staff performance
      const staffRows = await query(`
        SELECT
          CONCAT(s.first_name, ' ', s.last_name)                       AS staff_name,
          COUNT(*)                                                      AS total_queues,
          ROUND(AVG(h.service_duration), 1)                            AS avg_service_time,
          SUM(h.final_status = 'completed')                            AS completed_queues,
          ROUND(SUM(h.final_status='completed')/COUNT(*)*100, 1)       AS efficiency
        FROM queue_history h
        JOIN staff s ON h.staff_id = s.staff_id
        WHERE h.shop_id = ? ${filter}
        GROUP BY h.staff_id, s.first_name, s.last_name
        ORDER BY total_queues DESC
      `, base);

      const staff = staffRows.map(s => ({
        ...s,
        avg_service_time: s.avg_service_time || 0,
        efficiency:       s.efficiency       || 0,
      }));

      // 7. Counter performance
      const { filter: cFilter, params: cParams } = buildDateFilter('qh.created_at', period, start_date, end_date);
      const counterBase = [shop_id, ...cParams, shop_id];

      const counterRows = await query(`
        SELECT
          c.counter_name,
          COUNT(qh.queue_id)                                 AS total_queues,
          ROUND(SUM(qh.service_duration) / 60, 1)           AS active_hours,
          ROUND(SUM(qh.service_duration) / (8*60) * 100, 1) AS utilization
        FROM counters c
        LEFT JOIN queue_history qh ON qh.counter_id = c.counter_id AND qh.shop_id = ? ${cFilter}
        WHERE c.shop_id = ? AND c.is_active = 1 AND c.counter_status IN ('available','busy')
        GROUP BY c.counter_id, c.counter_name
        ORDER BY total_queues DESC
      `, counterBase);

      const counters = counterRows.map(c => ({
        counter_name: c.counter_name,
        total_queues: c.total_queues || 0,
        active_hours: c.active_hours || 0,
        utilization:  Math.min(c.utilization || 0, 100),
        status_class: utilClass(c.utilization || 0),
        status:       utilText(c.utilization  || 0),
      }));

      // Response
      res.json({ success: true, period, generated_at: new Date().toISOString(), overview, daily, status, hourly, services, staff, counters });

    } catch (e) {
      console.error('❌ Analytics error:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });
};