// server.js
// Stores phone subscriptions and pushes a notification to all of them on
// a schedule you control from the /admin page in your browser — no code
// editing needed after this point.

const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Uptime monitors (e.g. UptimeRobot) hit this every few minutes to keep
// the free-tier server awake, so the notification timer never sleeps.
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
  'mailto:you@example.com', // change to your real contact email
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

// ---------- Settings (notifications + interval), editable from /admin ----------
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

function loadSettings() {
  if (fs.existsSync(SETTINGS_FILE)) {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE));
  }
  // First-run defaults
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

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Simple shared secret so only you can reach /admin and change things.
// Change this to your own private word before deploying.
const ADMIN_SECRET = 'change-me-to-something-only-you-know';

function requireKey(req, res, next) {
  if (req.query.key !== ADMIN_SECRET) {
    return res.status(403).send('Wrong key. Add ?key=your-admin-secret to the URL.');
  }
  next();
}

async function sendNotificationToAll(notification) {
  const subs = loadSubs();
  if (subs.length === 0) {
    console.log('No subscribers yet, skipping send.');
    return { sent: 0 };
  }
  const payload = JSON.stringify(notification);
  const stillValid = [];

  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload);
      stillValid.push(sub);
    } catch (err) {
      // 410/404 means the subscription is dead (uninstalled, expired) — drop it.
      if (err.statusCode !== 410 && err.statusCode !== 404) {
        console.error('Push error:', err.statusCode, err.body);
        stillValid.push(sub);
      }
    }
  }
  saveSubs(stillValid);
  console.log(`Sent to ${stillValid.length} subscriber(s) at ${new Date().toLocaleTimeString()}`);
  return { sent: stillValid.length };
}

async function sendRandomToAll() {
  const settings = loadSettings();
  if (settings.notifications.length === 0) return;
  await sendNotificationToAll(pickRandom(settings.notifications));
}

// ---------- Admin page: edit notifications + interval, or send one now ----------
app.get('/admin', requireKey, (req, res) => {
  const settings = loadSettings();
  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Shopwise admin</title>
<style>
  body{font-family:-apple-system,sans-serif;max-width:520px;margin:30px auto;padding:0 20px;color:#161A2C;}
  h2{font-size:19px;margin-bottom:4px;}
  h3{font-size:14px;color:#6B7080;margin:28px 0 10px;text-transform:uppercase;letter-spacing:.04em;}
  .card{border:1px solid #E2E4EE;border-radius:10px;padding:14px;margin-bottom:10px;background:#fff;}
  label{display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#333;}
  input[type=text],textarea{width:100%;border:1px solid #E2E4EE;border-radius:6px;padding:8px 10px;font-size:13.5px;margin-bottom:8px;font-family:inherit;box-sizing:border-box;}
  input[type=number]{width:100px;border:1px solid #E2E4EE;border-radius:6px;padding:8px 10px;font-size:13.5px;}
  button{border:none;border-radius:8px;font-weight:600;font-size:13.5px;cursor:pointer;padding:10px 16px;}
  .btn-primary{background:#161A2C;color:#fff;}
  .btn-accent{background:#3D5AFE;color:#fff;}
  .btn-danger{background:transparent;color:#C4483A;border:1px solid #F0D4CE;padding:6px 10px;font-size:12px;}
  .btn-send{background:#1F9D55;color:#fff;padding:8px 12px;font-size:12.5px;}
  .row{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-top:8px;}
  #status{color:#6B7080;font-size:12.5px;min-height:18px;}
</style>
</head>
<body>
  <h2>Shopwise — admin</h2>
  <p style="color:#6B7080;font-size:13px;">Edit your notifications and timing here. Changes apply immediately, no code editing needed.</p>

  <h3>Send interval</h3>
  <div class="card">
    <label>Send a random notification every</label>
    <div style="display:flex;align-items:center;gap:8px;">
      <input type="number" id="intervalMinutes" min="1" value="${settings.intervalMinutes}">
      <span style="font-size:13.5px;">minutes</span>
      <button class="btn-primary" onclick="saveInterval()">Save</button>
    </div>
  </div>

  <h3>Notification versions</h3>
  <div id="notifList"></div>
  <button class="btn-accent" onclick="addNotification()">+ Add another version</button>

  <p id="status"></p>

<script>
  let notifications = ${JSON.stringify(settings.notifications)};
  const KEY = "${ADMIN_SECRET}";

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
          <button class="btn-send" onclick="sendNow(\${i})">Send this now</button>
          <button class="btn-danger" onclick="removeNotification(\${i})">Remove</button>
        </div>
      </div>
    \`).join('');
  }

  function escapeHtml(s){ const d=document.createElement('div'); d.innerText=s||''; return d.innerHTML; }
  function escapeAttr(s){ return (s||'').replace(/"/g,'&quot;'); }

  function updateField(i, field, value) {
    notifications[i][field] = value;
    saveNotifications();
  }

  function addNotification() {
    notifications.push({ title: 'Shopwise', body: 'New message', photo: '' });
    render();
    saveNotifications();
  }

  function removeNotification(i) {
    notifications.splice(i, 1);
    render();
    saveNotifications();
  }

  async function saveNotifications() {
    setStatus('Saving...');
    const res = await fetch('/admin/save-notifications?key=' + KEY, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ notifications })
    });
    setStatus(res.ok ? 'Saved.' : 'Error saving.');
  }

  async function saveInterval() {
    const minutes = parseInt(document.getElementById('intervalMinutes').value, 10);
    setStatus('Saving...');
    const res = await fetch('/admin/save-interval?key=' + KEY, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ intervalMinutes: minutes })
    });
    setStatus(res.ok ? 'Interval saved — takes effect on the next send.' : 'Error saving.');
  }

  async function sendNow(i) {
    setStatus('Sending...');
    const res = await fetch('/admin/send-now?key=' + KEY + '&index=' + i, { method: 'POST' });
    const data = await res.json();
    setStatus(data.sent !== undefined ? 'Sent to ' + data.sent + ' subscriber(s).' : 'Error: ' + (data.error || 'unknown'));
  }

  function setStatus(msg) {
    document.getElementById('status').textContent = msg;
  }

  render();
</script>
</body>
</html>
  `);
});

app.post('/admin/save-notifications', requireKey, (req, res) => {
  const settings = loadSettings();
  settings.notifications = req.body.notifications || [];
  saveSettings(settings);
  res.json({ ok: true });
});

app.post('/admin/save-interval', requireKey, (req, res) => {
  const minutes = parseInt(req.body.intervalMinutes, 10);
  if (!minutes || minutes < 1) {
    return res.status(400).json({ error: 'invalid interval' });
  }
  const settings = loadSettings();
  settings.intervalMinutes = minutes;
  saveSettings(settings);
  restartScheduler(); // pick up the new interval right away
  res.json({ ok: true });
});

app.post('/admin/send-now', requireKey, async (req, res) => {
  const index = parseInt(req.query.index, 10);
  const settings = loadSettings();
  const notification = settings.notifications[index];
  if (!notification) {
    return res.status(400).json({ error: 'invalid index' });
  }
  const result = await sendNotificationToAll(notification);
  res.json(result);
});

// ---------- Scheduler: re-reads settings each cycle, so interval changes ----------
// ---------- from the admin page take effect without restarting the server. ----------
let schedulerTimeout = null;

function scheduleNext() {
  if (schedulerTimeout) clearTimeout(schedulerTimeout);
  const settings = loadSettings();
  const ms = settings.intervalMinutes * 60 * 1000;
  schedulerTimeout = setTimeout(async () => {
    await sendRandomToAll();
    scheduleNext();
  }, ms);
}

function restartScheduler() {
  scheduleNext();
}

scheduleNext();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  const settings = loadSettings();
  console.log(`Sending a random notification to all subscribers every ${settings.intervalMinutes} minute(s).`);
  console.log(`Visit /admin?key=YOUR_ADMIN_SECRET to manage notifications and timing.`);
});
