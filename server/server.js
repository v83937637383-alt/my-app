// server.js
// Stores phone subscriptions and pushes a notification to all of them on
// a schedule you control from the /admin dashboard — no code editing needed.

const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/ping', (req, res) => {
  res.status(200).send('awake');
});

// ---------- VAPID keys ----------
const KEYS_FILE = path.join(__dirname, 'vapid-keys.json');
let vapidKeys;
if (fs.existsSync(KEYS_FILE)) {
  vapidKeys = JSON.parse(fs.readFileSync(KEYS_FILE));
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(KEYS_FILE, JSON.stringify(vapidKeys, null, 2));
  console.log('\nGenerated new VAPID keys — paste the public key into public/index.html:\n');
  console.log('PUBLIC KEY:', vapidKeys.publicKey);
  console.log('');
}

webpush.setVapidDetails(
  'mailto:you@example.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// ---------- Subscribers ----------
const SUBS_FILE = path.join(__dirname, 'subscribers.json');
function loadSubs() {
  if (!fs.existsSync(SUBS_FILE)) return [];
  return JSON.parse(fs.readFileSync(SUBS_FILE));
}
function saveSubs(subs) {
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2));
}

app.post('/subscribe', (req, res) => {
  const subs = loadSubs();
  const exists = subs.find(s => s.endpoint === req.body.endpoint);
  if (!exists) {
    subs.push(req.body);
    saveSubs(subs);
    console.log('New subscriber. Total:', subs.length);
  }
  res.status(201).json({ ok: true });
});

// ---------- Settings ----------
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
function loadSettings() {
  if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE));
  const defaults = {
    intervalMinutes: 5,
    notifications: [
      { title: 'Shopwise', body: 'New arrivals just landed — take a look.', photo: '' },
      { title: 'Shopwise', body: '20% off ends tonight.', photo: '' },
      { title: 'Shopwise', body: 'Your cart is waiting for you.', photo: '' }
    ]
  };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaults, null, 2));
  return defaults;
}
function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// ---------- Send log ----------
const LOG_FILE = path.join(__dirname, 'send-log.json');
function loadLog() {
  if (!fs.existsSync(LOG_FILE)) return [];
  return JSON.parse(fs.readFileSync(LOG_FILE));
}
function appendLog(entry) {
  const log = loadLog();
  log.unshift(entry);
  fs.writeFileSync(LOG_FILE, JSON.stringify(log.slice(0, 40), null, 2));
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'set-this-in-render';

function requireKey(req, res, next) {
  if (req.query.key !== ADMIN_SECRET) {
    return res.status(403).send('Wrong key. Add ?key=your-admin-secret to the URL.');
  }
  next();
}

async function sendNotificationToAll(notification, source) {
  const subs = loadSubs();
  if (subs.length === 0) {
    appendLog({ time: Date.now(), title: notification.title, body: notification.body, sent: 0, source });
    return { sent: 0 };
  }
  const payload = JSON.stringify(notification);
  const stillValid = [];

  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload);
      stillValid.push(sub);
    } catch (err) {
      if (err.statusCode !== 410 && err.statusCode !== 404) {
        stillValid.push(sub);
      }
    }
  }
  saveSubs(stillValid);
  appendLog({ time: Date.now(), title: notification.title, body: notification.body, sent: stillValid.length, source });
  return { sent: stillValid.length };
}

async function sendRandomToAll() {
  const settings = loadSettings();
  if (settings.notifications.length === 0) return;
  await sendNotificationToAll(pickRandom(settings.notifications), 'scheduled');
}

// ---------- JSON state endpoint (for live dashboard updates) ----------
let nextSendAt = Date.now();

app.get('/admin/api/state', requireKey, (req, res) => {
  const settings = loadSettings();
  res.json({
    subscriberCount: loadSubs().length,
    settings,
    log: loadLog(),
    nextSendAt
  });
});

app.post('/admin/save-notifications', requireKey, (req, res) => {
  const settings = loadSettings();
  settings.notifications = req.body.notifications || [];
  saveSettings(settings);
  res.json({ ok: true });
});

app.post('/admin/save-interval', requireKey, (req, res) => {
  const minutes = parseInt(req.body.intervalMinutes, 10);
  if (!minutes || minutes < 1) return res.status(400).json({ error: 'invalid interval' });
  const settings = loadSettings();
  settings.intervalMinutes = minutes;
  saveSettings(settings);
  restartScheduler();
  res.json({ ok: true });
});

app.post('/admin/send-now', requireKey, async (req, res) => {
  const index = parseInt(req.query.index, 10);
  const settings = loadSettings();
  const notification = settings.notifications[index];
  if (!notification) return res.status(400).json({ error: 'invalid index' });
  const result = await sendNotificationToAll(notification, 'manual');
  res.json(result);
});

// ---------- Scheduler ----------
let schedulerTimeout = null;

function scheduleNext() {
  if (schedulerTimeout) clearTimeout(schedulerTimeout);
  const settings = loadSettings();
  const ms = settings.intervalMinutes * 60 * 1000;
  nextSendAt = Date.now() + ms;
  schedulerTimeout = setTimeout(async () => {
    await sendRandomToAll();
    scheduleNext();
  }, ms);
}

function restartScheduler() {
  scheduleNext();
}

scheduleNext();

// ---------- Dashboard ----------
app.get('/admin', requireKey, (req, res) => {
  const settings = loadSettings();
  const subscriberCount = loadSubs().length;
  const log = loadLog();

  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Shopwise — dispatch</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#12141C;
    --panel:#1A1D29;
    --panel-2:#20243A;
    --border:#2A2E3D;
    --text:#EDEEF3;
    --muted:#8A8FA6;
    --amber:#FFA23D;
    --teal:#33D6B0;
    --danger:#FF6B6B;
  }
  *{box-sizing:border-box;margin:0;padding:0;}
  body{
    background:var(--bg); color:var(--text);
    font-family:'Inter',sans-serif;
    min-height:100vh;
    -webkit-font-smoothing:antialiased;
  }
  h1,h2,.display{font-family:'Sora',sans-serif;}
  .mono{font-family:'IBM Plex Mono',monospace;}

  .topbar{
    display:flex; align-items:center; gap:14px;
    padding:20px 24px; border-bottom:1px solid var(--border);
    flex-wrap:wrap;
  }
  .mark{
    width:30px;height:30px;border-radius:9px;
    background:radial-gradient(circle at 35% 35%, var(--amber), #C9701A 70%);
    flex-shrink:0; position:relative;
  }
  .mark::after{
    content:""; position:absolute; inset:8px; border-radius:50%;
    background:var(--bg); opacity:.85;
  }
  .brand{font-size:15px; font-weight:600; letter-spacing:-0.01em;}
  .brand-sub{font-size:11px; color:var(--muted); font-family:'IBM Plex Mono',monospace;}

  .tabs{
    display:flex; gap:2px; margin-left:auto;
    background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:3px;
  }
  .tab{
    padding:8px 16px; font-size:12.5px; font-weight:600; border-radius:8px;
    color:var(--muted); cursor:pointer; transition:background .15s,color .15s;
    white-space:nowrap;
  }
  .tab.active{background:var(--panel-2); color:var(--text);}

  main{max-width:760px; margin:0 auto; padding:32px 24px 80px;}
  .view{display:none;} .view.active{display:block;}

  .eyebrow{
    font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.08em;
    text-transform:uppercase; color:var(--amber); margin-bottom:8px;
  }

  /* ---- Home / signal pulse ---- */
  .pulse-wrap{
    display:flex; flex-direction:column; align-items:center;
    padding:40px 20px 30px;
  }
  .pulse{
    position:relative; width:220px; height:220px;
    display:flex; align-items:center; justify-content:center;
  }
  .ring{
    position:absolute; border-radius:50%; border:1px solid var(--teal);
    opacity:0; animation:pulseOut 3s ease-out infinite;
  }
  .ring:nth-child(1){width:100%; height:100%; animation-delay:0s;}
  .ring:nth-child(2){width:100%; height:100%; animation-delay:1s;}
  .ring:nth-child(3){width:100%; height:100%; animation-delay:2s;}
  @keyframes pulseOut{
    0%{ transform:scale(.4); opacity:.7; }
    100%{ transform:scale(1); opacity:0; }
  }
  .pulse-core{
    width:120px; height:120px; border-radius:50%;
    background:var(--panel); border:1px solid var(--border);
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    z-index:2;
  }
  .pulse-time{font-family:'IBM Plex Mono',monospace; font-size:22px; font-weight:500; color:var(--teal);}
  .pulse-label{font-size:10px; color:var(--muted); margin-top:2px; text-transform:uppercase; letter-spacing:.06em;}

  .stat-row{display:flex; gap:12px; justify-content:center; flex-wrap:wrap; margin-top:10px;}
  .stat{
    background:var(--panel); border:1px solid var(--border); border-radius:10px;
    padding:14px 20px; text-align:center; min-width:110px;
  }
  .stat-num{font-family:'Sora',sans-serif; font-size:22px; font-weight:600;}
  .stat-label{font-size:11px; color:var(--muted); margin-top:2px;}

  /* ---- Notifications ---- */
  .card{
    background:var(--panel); border:1px solid var(--border); border-radius:12px;
    padding:16px; margin-bottom:12px;
  }
  label{
    display:block; font-family:'IBM Plex Mono',monospace; font-size:10.5px;
    letter-spacing:.06em; text-transform:uppercase; color:var(--muted); margin-bottom:6px;
  }
  input[type=text],input[type=number],textarea{
    width:100%; background:#12141C; border:1px solid var(--border); border-radius:7px;
    padding:9px 11px; color:var(--text); font-size:13.5px; font-family:'Inter',sans-serif;
    margin-bottom:10px;
  }
  input:focus,textarea:focus{outline:none; border-color:var(--teal);}
  .row{display:flex; justify-content:space-between; align-items:center; gap:8px;}
  button{border:none; border-radius:8px; font-weight:600; font-size:13px; cursor:pointer; padding:9px 16px; font-family:'Inter',sans-serif;}
  .btn-amber{background:var(--amber); color:#1A1200;}
  .btn-teal{background:var(--teal); color:#062820;}
  .btn-ghost{background:transparent; color:var(--muted); border:1px solid var(--border);}
  .btn-danger{background:transparent; color:var(--danger); border:1px solid #4A2A2A; padding:7px 12px; font-size:12px;}
  .add-btn{width:100%; padding:12px; background:var(--panel); border:1px dashed var(--border); color:var(--muted); border-radius:10px;}

  .interval-card{display:flex; align-items:center; gap:10px; flex-wrap:wrap;}
  .interval-card input{width:90px; margin:0;}

  #status{font-family:'IBM Plex Mono',monospace; font-size:11.5px; color:var(--teal); min-height:16px; margin:10px 0;}

  /* ---- Log ---- */
  .log-entry{
    display:flex; gap:12px; padding:12px 0; border-bottom:1px solid var(--border);
    font-size:13px;
  }
  .log-time{font-family:'IBM Plex Mono',monospace; font-size:11px; color:var(--muted); white-space:nowrap; padding-top:2px;}
  .log-body{flex:1;}
  .log-title{font-weight:600;}
  .log-meta{font-size:11.5px; color:var(--muted); margin-top:2px;}
  .tag{font-family:'IBM Plex Mono',monospace; font-size:9.5px; text-transform:uppercase; padding:2px 6px; border-radius:4px; margin-right:6px;}
  .tag-scheduled{background:#2A2E3D; color:var(--muted);}
  .tag-manual{background:#3A2E14; color:var(--amber);}
  .empty{text-align:center; color:var(--muted); font-size:13px; padding:30px 0;}
</style>
</head>
<body>

<div class="topbar">
  <div class="mark"></div>
  <div>
    <div class="brand">Shopwise</div>
    <div class="brand-sub">dispatch console</div>
  </div>
  <div class="tabs">
    <div class="tab active" data-tab="home">Home</div>
    <div class="tab" data-tab="notifs">Notifications</div>
    <div class="tab" data-tab="log">Log</div>
  </div>
</div>

<main>

  <div class="view active" id="view-home">
    <div class="eyebrow">Signal status</div>
    <div class="pulse-wrap">
      <div class="pulse">
        <div class="ring"></div>
        <div class="ring"></div>
        <div class="ring"></div>
        <div class="pulse-core">
          <div class="pulse-time mono" id="countdown">--:--</div>
          <div class="pulse-label">next transmission</div>
        </div>
      </div>
      <div class="stat-row">
        <div class="stat">
          <div class="stat-num" id="subCount">0</div>
          <div class="stat-label">subscribers</div>
        </div>
        <div class="stat">
          <div class="stat-num" id="intervalDisplay">5</div>
          <div class="stat-label">min interval</div>
        </div>
        <div class="stat">
          <div class="stat-num" id="totalSent">0</div>
          <div class="stat-label">sent (recent)</div>
        </div>
      </div>
    </div>
  </div>

  <div class="view" id="view-notifs">
    <div class="eyebrow">Timing</div>
    <div class="card interval-card">
      <label style="margin:0;">Every</label>
      <input type="number" id="intervalMinutes" min="1" value="${settings.intervalMinutes}">
      <span style="font-size:13px;color:var(--muted);">minutes</span>
      <button class="btn-amber" onclick="saveInterval()" style="margin-left:auto;">Save</button>
    </div>

    <div class="eyebrow" style="margin-top:26px;">Notification versions</div>
    <div id="notifList"></div>
    <button class="add-btn" onclick="addNotification()">+ Add another version</button>
    <p id="status"></p>
  </div>

  <div class="view" id="view-log">
    <div class="eyebrow">Recent transmissions</div>
    <div id="logList"></div>
  </div>

</main>

<script>
  const KEY = "${ADMIN_SECRET}";
  let notifications = ${JSON.stringify(settings.notifications)};
  let nextSendAt = ${nextSendAt};

  // ---- tabs ----
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('view-' + tab.dataset.tab).classList.add('active');
    });
  });

  // ---- notifications editor ----
  function render() {
    const list = document.getElementById('notifList');
    list.innerHTML = notifications.map((n, i) => \`
      <div class="card">
        <label>Title</label>
        <input type="text" value="\${escapeAttr(n.title)}" onchange="updateField(\${i}, 'title', this.value)">
        <label>Message</label>
        <textarea rows="2" onchange="updateField(\${i}, 'body', this.value)">\${escapeHtml(n.body)}</textarea>
        <label>Photo URL (optional)</label>
        <input type="text" value="\${escapeAttr(n.photo || '')}" onchange="updateField(\${i}, 'photo', this.value)">
        <div class="row">
          <button class="btn-teal" onclick="sendNow(\${i})">Send this now</button>
          <button class="btn-danger" onclick="removeNotification(\${i})">Remove</button>
        </div>
      </div>
    \`).join('');
  }
  function escapeHtml(s){ const d=document.createElement('div'); d.innerText=s||''; return d.innerHTML; }
  function escapeAttr(s){ return (s||'').replace(/"/g,'&quot;'); }

  function updateField(i, field, value) { notifications[i][field] = value; saveNotifications(); }
  function addNotification() { notifications.push({ title:'Shopwise', body:'New message', photo:'' }); render(); saveNotifications(); }
  function removeNotification(i) { notifications.splice(i,1); render(); saveNotifications(); }

  async function saveNotifications() {
    setStatus('Saving...');
    const res = await fetch('/admin/save-notifications?key=' + KEY, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ notifications })
    });
    setStatus(res.ok ? 'Saved.' : 'Error saving.');
  }

  async function saveInterval() {
    const minutes = parseInt(document.getElementById('intervalMinutes').value, 10);
    setStatus('Saving...');
    const res = await fetch('/admin/save-interval?key=' + KEY, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ intervalMinutes: minutes })
    });
    setStatus(res.ok ? 'Interval saved.' : 'Error saving.');
    refreshState();
  }

  async function sendNow(i) {
    setStatus('Sending...');
    const res = await fetch('/admin/send-now?key=' + KEY + '&index=' + i, { method:'POST' });
    const data = await res.json();
    setStatus(data.sent !== undefined ? 'Sent to ' + data.sent + ' subscriber(s).' : 'Error.');
    refreshState();
  }

  function setStatus(msg) { document.getElementById('status').textContent = msg; }

  // ---- log ----
  function renderLog(log) {
    const el = document.getElementById('logList');
    if (!log.length) { el.innerHTML = '<div class="empty">Nothing sent yet.</div>'; return; }
    el.innerHTML = log.map(entry => {
      const d = new Date(entry.time);
      const time = d.toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
      const tagClass = entry.source === 'manual' ? 'tag-manual' : 'tag-scheduled';
      return \`
        <div class="log-entry">
          <div class="log-time mono">\${time}</div>
          <div class="log-body">
            <span class="tag \${tagClass}">\${entry.source}</span>
            <span class="log-title">\${escapeHtml(entry.title)}</span>
            <div class="log-meta">\${escapeHtml(entry.body)} · sent to \${entry.sent}</div>
          </div>
        </div>
      \`;
    }).join('');
  }

  // ---- countdown + live state polling ----
  function tickCountdown() {
    const remaining = Math.max(0, nextSendAt - Date.now());
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000).toString().padStart(2,'0');
    document.getElementById('countdown').textContent = m + ':' + s;
  }

  async function refreshState() {
    try {
      const res = await fetch('/admin/api/state?key=' + KEY);
      const data = await res.json();
      document.getElementById('subCount').textContent = data.subscriberCount;
      document.getElementById('intervalDisplay').textContent = data.settings.intervalMinutes;
      document.getElementById('totalSent').textContent = data.log.reduce((sum, e) => sum + e.sent, 0);
      nextSendAt = data.nextSendAt;
      renderLog(data.log);
    } catch (e) {}
  }

  render();
  refreshState();
  setInterval(tickCountdown, 1000);
  setInterval(refreshState, 15000);
</script>
</body>
</html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  const settings = loadSettings();
  console.log(`Sending a random notification to all subscribers every ${settings.intervalMinutes} minute(s).`);
  console.log(`Visit /admin?key=YOUR_ADMIN_SECRET to manage notifications and timing.`);
});
