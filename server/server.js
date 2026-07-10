// server.js
// Stores phone subscriptions and pushes a random notification to all of
// them every 5 minutes. Run this once, keep it running (e.g. on Render,
// Railway, Fly.io, or your own VPS) and it will notify every phone that
// has the app installed and notifications turned on.

const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Uptime monitors (e.g. UptimeRobot) hit this every few minutes to keep
// the free-tier server awake, so the 5-minute notification timer never sleeps.
app.get('/ping', (req, res) => {
  res.status(200).send('awake');
});

// ---------- VAPID keys ----------
// These identify your server to the push services (Apple/Google/Mozilla).
// Generate once, then keep them the same forever — if you change them,
// every existing subscriber has to re-subscribe.
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

// ---------- Notification versions ----------
// Add as many as you want — one is picked at random on every send.
const NOTIFICATION_VERSIONS = [
  {
    title: 'Shopify',
    body: 'Fashion has a new order for 2 items totaling $ 70.49 from Online store.',
    photo: 'https://www.google.com/url?sa=t&source=web&rct=j&url=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdev%3Fid%3D8929232438554100687&ved=0CBYQjRxqFwoTCIi6gdiEyZUDFQAAAAAdAAAAABA3&opi=89978449'
  },
  {
    title: 'Shopify',
    body: 'Wow has a new order for 1 items totaling $ 19.50 from Online store.',
    photo: 'https://www.google.com/url?sa=t&source=web&rct=j&url=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdev%3Fid%3D8929232438554100687&ved=0CBYQjRxqFwoTCIi6gdiEyZUDFQAAAAAdAAAAABA3&opi=89978449'
  },
  {
    title: 'Shopify',
    body: 'Cool has a new order for 3 items totaling $ 103.39 from Online store.,
    photo: 'https://www.google.com/url?sa=t&source=web&rct=j&url=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdev%3Fid%3D8929232438554100687&ved=0CBYQjRxqFwoTCIi6gdiEyZUDFQAAAAAdAAAAABA3&opi=89978449'
  }
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function sendToAll() {
  const subs = loadSubs();
  if (subs.length === 0) {
    console.log('No subscribers yet, skipping send.');
    return;
  }
  const payload = JSON.stringify(pickRandom(NOTIFICATION_VERSIONS));
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
}

// ---------- Every 5 minutes ----------
const FIVE_MINUTES = 5 * 60 * 1000;
setInterval(sendToAll, FIVE_MINUTES);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Sending a random notification to all subscribers every 5 minutes.');
});
