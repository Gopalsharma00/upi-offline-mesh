// ─── State ───
let nodes = [];
let animations = [];
let bluetoothRange = 150;
let dragNode = null;
let dragOffX = 0, dragOffY = 0;
const canvas = document.getElementById('meshCanvas');
const ctx = canvas.getContext('2d');

// ─── Resize ───
function resize() {
  canvas.width = canvas.parentElement.clientWidth;
  canvas.height = canvas.parentElement.clientHeight;
}
window.addEventListener('resize', resize);
resize();

// ─── Node positions (circle layout) ───
function layoutNodes() {
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const radius = Math.min(cx, cy) * 0.38;
  nodes.forEach((n, i) => {
    if (n.x !== undefined && n.y !== undefined) return; // keep dragged positions
    const angle = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
    n.x = cx + Math.cos(angle) * radius;
    n.y = cy + Math.sin(angle) * radius;
  });
}

// ─── Draw ───
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const time = Date.now();

  // Draw bluetooth range circles
  nodes.forEach(n => {
    ctx.beginPath();
    ctx.arc(n.x, n.y, bluetoothRange, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(99,102,241,0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();
  });

  // Draw connections between nodes in range
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist <= bluetoothRange * 2) {
        const opacity = Math.max(0.03, 0.2 - (dist / (bluetoothRange * 2)) * 0.17);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        // Dashed line for bluetooth
        ctx.setLineDash([4, 6]);
        ctx.strokeStyle = `rgba(99,102,241,${opacity})`;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  // Draw packet transfer animations
  animations = animations.filter(a => {
    const elapsed = time - a.start;
    const duration = a.duration || 800;
    if (elapsed > duration) return false;
    const t = elapsed / duration;
    const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    const x = a.fromX + (a.toX - a.fromX) * eased;
    const y = a.fromY + (a.toY - a.fromY) * eased;
    // Glowing packet dot
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    const color = a.color || '#6366f1';
    ctx.fillStyle = color;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.fillStyle = color.replace(')', ',0.2)').replace('rgb', 'rgba');
    ctx.fill();
    // Trail
    const trailT = Math.max(0, eased - 0.08);
    const tx = a.fromX + (a.toX - a.fromX) * trailT;
    const ty = a.fromY + (a.toY - a.fromY) * trailT;
    ctx.beginPath();
    ctx.moveTo(tx, ty); ctx.lineTo(x, y);
    ctx.strokeStyle = color.replace(')', ',0.4)').replace('rgb', 'rgba');
    ctx.lineWidth = 2;
    ctx.stroke();
    return true;
  });

  // Draw nodes
  nodes.forEach(n => {
    const isOnline = n.hasInternet;
    const pkts = n.packetCount || 0;
    // Glow if has packets
    if (pkts > 0) {
      const grd = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, 35);
      grd.addColorStop(0, 'rgba(99,102,241,0.25)');
      grd.addColorStop(1, 'rgba(99,102,241,0)');
      ctx.beginPath(); ctx.arc(n.x, n.y, 35, 0, Math.PI * 2);
      ctx.fillStyle = grd; ctx.fill();
    }
    // Online indicator ring
    if (isOnline) {
      ctx.beginPath(); ctx.arc(n.x, n.y, 24, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(34,197,94,0.6)';
      ctx.lineWidth = 2; ctx.stroke();
      // Pulsing ring
      const pulse = (Math.sin(time / 600) + 1) / 2;
      ctx.beginPath(); ctx.arc(n.x, n.y, 24 + pulse * 6, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(34,197,94,${0.15 * (1 - pulse)})`;
      ctx.lineWidth = 1.5; ctx.stroke();
    }
    // Phone body
    ctx.beginPath();
    ctx.arc(n.x, n.y, 20, 0, Math.PI * 2);
    ctx.fillStyle = isOnline ? '#1a3a2a' : '#1e2a45';
    ctx.fill();
    ctx.strokeStyle = isOnline ? '#22c55e' : '#475569';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Emoji icon
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(isOnline ? '📶' : '📱', n.x, n.y);
    // Label
    const label = n.deviceId.replace('phone-', '');
    ctx.font = '500 11px Inter, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(label, n.x, n.y + 34);
    // Packet count badge
    if (pkts > 0) {
      ctx.beginPath();
      ctx.arc(n.x + 16, n.y - 16, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#6366f1';
      ctx.fill();
      ctx.font = 'bold 9px Inter, sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText(pkts, n.x + 16, n.y - 15);
    }
  });

  requestAnimationFrame(draw);
}

// ─── Drag support ───
canvas.addEventListener('mousedown', e => {
  const r = canvas.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  for (const n of nodes) {
    if (Math.hypot(mx - n.x, my - n.y) < 25) {
      dragNode = n; dragOffX = mx - n.x; dragOffY = my - n.y;
      canvas.classList.add('grabbing');
      break;
    }
  }
});
canvas.addEventListener('mousemove', e => {
  if (!dragNode) return;
  const r = canvas.getBoundingClientRect();
  dragNode.x = e.clientX - r.left - dragOffX;
  dragNode.y = e.clientY - r.top - dragOffY;
});
canvas.addEventListener('mouseup', () => { dragNode = null; canvas.classList.remove('grabbing'); });
canvas.addEventListener('mouseleave', () => { dragNode = null; canvas.classList.remove('grabbing'); });

// ─── Animate packet transfer ───
function animateTransfer(fromId, toId, color) {
  const from = nodes.find(n => n.deviceId === fromId);
  const to = nodes.find(n => n.deviceId === toId);
  if (!from || !to) return;
  animations.push({
    fromX: from.x, fromY: from.y, toX: to.x, toY: to.y,
    start: Date.now() + Math.random() * 300, duration: 600 + Math.random() * 400,
    color: color || 'rgb(99,102,241)'
  });
}

// ─── API helpers ───
async function api(url, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${method} ${url} -> HTTP ${r.status}`);
  return r.json();
}

// ─── Refresh state ───
let refreshFailures = 0;
let redisWarned = false;

function logRefreshFailure(e) {
  refreshFailures++;
  // refresh() polls every 5s. Log the first failure, then once a minute, so an
  // outage reports itself without flooding the log pane.
  if (refreshFailures === 1 || refreshFailures % 12 === 0) {
    logMsg(`❌ Backend unreachable (${e.message}) — showing last known mesh state`, 'throttled');
  }
}

async function refresh() {
  let state = null;
  try {
    state = await api('/api/mesh/state');
    refreshFailures = 0;
  } catch (e) {
    // Keep whatever is already drawn. Wiping every node because one poll failed
    // is what turned a backend outage into an empty canvas.
    logRefreshFailure(e);
  }

  if (state) {
    if (state.redisAvailable === false && !redisWarned) {
      redisWarned = true;
      logMsg('⚠ Redis unreachable — settlement pipeline is offline. Mesh simulation still works, but Flush to Bank will not settle.', 'throttled');
    }

    const deviceData = state.devices || [];
    // Update existing nodes or add new ones
    deviceData.forEach(d => {
      let n = nodes.find(nd => nd.deviceId === d.deviceId);
      if (n) {
        n.hasInternet = d.hasInternet;
        n.packetCount = d.packetCount;
        n.packetIds = d.packetIds;
      } else {
        nodes.push({ deviceId: d.deviceId, hasInternet: d.hasInternet, packetCount: d.packetCount, packetIds: d.packetIds });
      }
    });
    // Remove nodes no longer in backend
    nodes = nodes.filter(n => deviceData.some(d => d.deviceId === n.deviceId));
    layoutNodes();
    updateDeviceList();
  }

  // Balances and transactions come from Postgres and are independent of the
  // mesh endpoint — keep them refreshing even when the mesh poll fails.
  updateAccounts();
  updateTransactions();
}

function updateDeviceList() {
  const el = document.getElementById('deviceList');
  if (!el) return;
  el.innerHTML = nodes.map(n => `
    <div class="device-item">
      <div class="device-status">
        <span class="status-dot ${n.hasInternet ? 'online' : 'offline'}"></span>
        <span>${n.deviceId.replace('phone-','')}</span>
        <span style="color:var(--text-dim);font-size:0.65rem;">(${n.packetCount || 0} pkts)</span>
      </div>
      <div style="display:flex;gap:4px;">
        <button class="btn btn-ghost btn-sm" onclick="toggleInternet('${n.deviceId}')">${n.hasInternet ? '📴' : '📶'}</button>
        <button class="btn btn-ghost btn-sm" onclick="removeDevice('${n.deviceId}')">✕</button>
      </div>
    </div>
  `).join('');
}

async function updateAccounts() {
  try {
    const accs = await api('/api/accounts');
    const el = document.getElementById('accountList');
    if (!el) return;
    el.innerHTML = accs.map(a => `
      <div class="account-item">
        <span class="account-name">${a.holderName} <span style="color:var(--text-dim);font-size:0.7rem;">(${a.vpa})</span></span>
        <span class="account-bal">₹${parseFloat(a.balance).toFixed(2)}</span>
      </div>
    `).join('');
  } catch(e) {}
}

async function updateTransactions() {
  try {
    const txs = await api('/api/transactions');
    const el = document.getElementById('txList');
    const countEl = document.getElementById('txCount');
    if (!el) return;
    if (countEl) countEl.textContent = txs && txs.length ? `(${txs.length})` : '';
    if (!txs || txs.length === 0) {
      el.innerHTML = '<div style="color:var(--text-dim);font-size:0.7rem;">No transactions yet</div>';
      return;
    }
    el.innerHTML = txs.slice(0, 10).map(tx =>
      `<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:0.72rem;border-bottom:1px solid var(--border);">
        <span><span style="color:var(--red);">${tx.senderVpa.split('@')[0]}</span> → <span style="color:var(--green);">${tx.receiverVpa.split('@')[0]}</span></span>
        <span style="color:var(--orange);">₹${parseFloat(tx.amount).toFixed(0)}</span>
      </div>`
    ).join('');
  } catch(e) {}
}

// ─── Actions ───
async function sendPacket() {
  const sender = document.getElementById('senderVpa').value;
  const receiver = document.getElementById('receiverVpa').value;
  const amount = parseFloat(document.getElementById('amount').value);
  const pin = document.getElementById('pin').value;
  try {
    const r = await api('/api/demo/send', 'POST', { senderVpa: sender, receiverVpa: receiver, amount, pin });
    logMsg(`📤 Packet ${r.packetId.substring(0,8)} encrypted & injected at ${r.injectedAt} (TTL ${r.ttl})`, 'accepted');
    toast('🔐 Packet encrypted with RSA-2048 + AES-256-GCM');
    refresh();
  } catch(e) { logMsg('❌ Failed to inject packet', 'throttled'); }
}

async function gossip() {
  try {
    // Compute which devices are within BLE range of each other
    const neighbors = {};
    nodes.forEach(n => { neighbors[n.deviceId] = []; });
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dist = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
        if (dist <= bluetoothRange * 2) {
          neighbors[nodes[i].deviceId].push(nodes[j].deviceId);
          neighbors[nodes[j].deviceId].push(nodes[i].deviceId);
        }
      }
    }
    // Send neighbor map so backend only gossips between in-range pairs
    const r = await api('/api/mesh/gossip', 'POST', neighbors);
    logMsg(`🔄 Gossip: ${r.transfers} transfer(s) — ${JSON.stringify(r.deviceCounts)}`);
    // Animate transfers between in-range pairs only
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dist = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
        if (dist <= bluetoothRange * 2 && r.transfers > 0) {
          animateTransfer(nodes[i].deviceId, nodes[j].deviceId, 'rgb(99,102,241)');
          animateTransfer(nodes[j].deviceId, nodes[i].deviceId, 'rgb(99,102,241)');
        }
      }
    }
    refresh();
  } catch(e) { logMsg('❌ Gossip failed', 'throttled'); }
}

async function flushBridges() {
  try {
    const r = await api('/api/mesh/flush', 'POST');
    logMsg(`📡 ${r.uploadsAttempted} bridge upload(s):`);
    r.results.forEach(res => {
      const isVip = res.hopCount === 0;
      const vipTag = isVip ? ' ⭐VIP' : '';
      const icon = res.outcome === 'ACCEPTED_FOR_PROCESSING' ? '⚡'
                 : res.outcome === 'DUPLICATE_DROPPED' ? '🔁'
                 : res.outcome === 'THROTTLED' ? '🛑' : '❌';
      const cls = res.outcome === 'ACCEPTED_FOR_PROCESSING' ? 'accepted'
                : res.outcome === 'THROTTLED' ? 'throttled'
                : res.outcome === 'DUPLICATE_DROPPED' ? 'duplicate' : '';
      logMsg(`  ${icon} [${res.bridgeNode}] ${res.packetId} → ${res.outcome}${vipTag}`, isVip ? 'vip' : cls);
      // Animate bridge → bank (upward)
      if (res.outcome === 'ACCEPTED_FOR_PROCESSING') {
        const bn = nodes.find(n => n.deviceId === res.bridgeNode);
        if (bn) {
          animations.push({
            fromX: bn.x, fromY: bn.y, toX: bn.x, toY: bn.y - 120,
            start: Date.now(), duration: 1000, color: 'rgb(34,197,94)'
          });
        }
      }
    });
    logMsg('  ↪ AsyncDecryptionWorker processing in background...');
    setTimeout(refresh, 1500);
  } catch(e) { logMsg('❌ Failed to flush bridges', 'throttled'); }
}

async function resetMesh() {
  try {
    await api('/api/mesh/reset', 'POST');
    logMsg('🗑 Full system reset: Mesh + Redis + DB cleared');
    // Keep node positions intact, just reset their packet counts visually
    nodes.forEach(n => { n.packetCount = 0; n.packetIds = []; });
  } catch (e) {
    // The reset endpoint clears the Redis idempotency cache and queue first, so
    // it fails as a unit whenever Redis is down.
    logMsg(`❌ Reset failed (${e.message}) — needs Redis`, 'throttled');
  }
  refresh();
}

async function toggleInternet(deviceId) {
  try {
    await api(`/api/mesh/device/${deviceId}/toggle-internet`, 'POST');
    const n = nodes.find(nd => nd.deviceId === deviceId);
    logMsg(`⚡ ${deviceId} → ${n && !n.hasInternet ? 'ONLINE' : 'OFFLINE'}`);
  } catch (e) {
    logMsg(`❌ Could not toggle ${deviceId} (${e.message})`, 'throttled');
  }
  refresh();
}

async function addDeviceFromForm() {
  const input = document.getElementById('newDeviceId');
  const id = 'phone-' + input.value.trim().toLowerCase().replace(/\s+/g, '-');
  if (!input.value.trim()) return;
  try {
    await api('/api/mesh/device/add', 'POST', { deviceId: id, hasInternet: false });
    input.value = '';
    logMsg(`➕ Added device ${id}`);
  } catch (e) {
    logMsg(`❌ Could not add ${id} (${e.message})`, 'throttled');
  }
  refresh();
}

async function removeDevice(deviceId) {
  try {
    await api(`/api/mesh/device/${deviceId}/remove`, 'POST');
    logMsg(`➖ Removed device ${deviceId}`);
  } catch (e) {
    logMsg(`❌ Could not remove ${deviceId} (${e.message})`, 'throttled');
  }
  refresh();
}

// ─── Log ───
function logMsg(msg, cls = '') {
  const el = document.getElementById('activityLog');
  if (!el) return;
  const ts = new Date().toLocaleTimeString('en-IN', { hour12: false });
  const div = document.createElement('div');
  div.className = 'log-entry' + (cls ? ' ' + cls : '');
  div.textContent = `[${ts}] ${msg}`;
  el.prepend(div);
  // Keep max 100 entries
  while (el.children.length > 100) el.removeChild(el.lastChild);
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ─── Range slider ───
function updateRange(val) {
  bluetoothRange = parseInt(val);
  document.getElementById('rangeVal').textContent = val + 'px';
}

// ─── Init ───
refresh();
draw();
setInterval(refresh, 5000);
