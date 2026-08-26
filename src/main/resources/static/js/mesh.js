// ─── State ───────────────────────────────────────────────────────────────────
let nodes = [];
let animations = [];
let bluetoothRange = 150;
let dragNode = null;
let hoverNode = null;
let rangeRevealUntil = 0;
let dragOffX = 0, dragOffY = 0;
let rafId = null;
let pollId = null;

const canvas = document.getElementById('meshCanvas');
const ctx = canvas.getContext('2d');

// Palette mirrors the CSS custom properties so canvas and DOM stay in step.
const C = {
  online:  '#3fb950',
  offline: '#56606e',
  packet:  '#4c8dff',
  vip:     '#d29922',
  label:   '#8695a8',
  ring:    'rgba(76,141,255,0.06)',
  link:    'rgba(110,130,160,',
  faceOn:  '#132a1a',
  faceOff: '#161c27',
};

// ─── Sizing ──────────────────────────────────────────────────────────────────
// Back the canvas with devicePixelRatio so nodes and labels stay crisp on
// high-density displays instead of being upscaled from CSS pixels.
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.parentElement.clientWidth;
  const h = canvas.parentElement.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', () => { resize(); layoutNodes(true); });
resize();

function viewW() { return canvas.parentElement.clientWidth; }
function viewH() { return canvas.parentElement.clientHeight; }

// ─── Node positions (circle layout) ──────────────────────────────────────────
function layoutNodes(force = false) {
  const cx = viewW() / 2, cy = viewH() / 2;
  const radius = Math.min(cx, cy) * 0.55;
  nodes.forEach((n, i) => {
    if (!force && n.x !== undefined && n.y !== undefined) return; // keep dragged positions
    const angle = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
    n.x = cx + Math.cos(angle) * radius;
    n.y = cy + Math.sin(angle) * radius;
  });
}

// ─── Draw ────────────────────────────────────────────────────────────────────
function drawSignalGlyph(x, y, online) {
  // Three stacked arcs plus a dot. Replaces the emoji that used to be painted
  // here, which rendered differently on every platform.
  ctx.strokeStyle = online ? C.online : C.offline;
  ctx.lineWidth = 1.4;
  ctx.lineCap = 'round';
  const arcs = online ? [8, 5.5] : [5.5];
  arcs.forEach(r => {
    ctx.beginPath();
    ctx.arc(x, y + 4, r, Math.PI * 1.22, Math.PI * 1.78);
    ctx.stroke();
  });
  ctx.beginPath();
  ctx.arc(x, y + 4.5, 1.35, 0, Math.PI * 2);
  ctx.fillStyle = online ? C.online : C.offline;
  ctx.fill();
  if (!online) {
    ctx.beginPath();
    ctx.moveTo(x - 8, y - 5);
    ctx.lineTo(x + 8, y + 8);
    ctx.strokeStyle = C.offline;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }
}

function draw() {
  const w = viewW(), h = viewH();
  ctx.clearRect(0, 0, w, h);
  const time = Date.now();

  // Range rings. Drawing one per node at all times buried the topology in
  // overlapping circles, so they appear for the node you are touching and for a
  // moment after the range slider moves.
  const revealAll = time < rangeRevealUntil;
  nodes.forEach(n => {
    const focused = n === dragNode || n === hoverNode;
    if (!focused && !revealAll) return;
    ctx.beginPath();
    ctx.arc(n.x, n.y, bluetoothRange, 0, Math.PI * 2);
    ctx.strokeStyle = focused ? 'rgba(76,141,255,0.28)' : C.ring;
    ctx.setLineDash(focused ? [] : [2, 6]);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  });

  // Links between in-range pairs
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist <= bluetoothRange * 2) {
        const opacity = Math.max(0.06, 0.26 - (dist / (bluetoothRange * 2)) * 0.2);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.setLineDash([3, 5]);
        ctx.strokeStyle = C.link + opacity + ')';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  // Packets in transit
  animations = animations.filter(a => {
    const elapsed = time - a.start;
    if (elapsed < 0) return true;
    const duration = a.duration || 800;
    if (elapsed > duration) return false;
    const t = elapsed / duration;
    const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    const x = a.fromX + (a.toX - a.fromX) * eased;
    const y = a.fromY + (a.toY - a.fromY) * eased;
    const color = a.color || C.packet;

    const trailT = Math.max(0, eased - 0.1);
    ctx.beginPath();
    ctx.moveTo(a.fromX + (a.toX - a.fromX) * trailT, a.fromY + (a.toY - a.fromY) * trailT);
    ctx.lineTo(x, y);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.beginPath();
    ctx.arc(x, y, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    return true;
  });

  // Nodes
  nodes.forEach(n => {
    const online = n.hasInternet;
    const pkts = n.packetCount || 0;

    if (online) {
      const pulse = (Math.sin(time / 900) + 1) / 2;
      ctx.beginPath();
      ctx.arc(n.x, n.y, 21 + pulse * 5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(63,185,80,' + (0.2 * (1 - pulse)).toFixed(3) + ')';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(n.x, n.y, 19, 0, Math.PI * 2);
    ctx.fillStyle = online ? C.faceOn : C.faceOff;
    ctx.fill();
    ctx.strokeStyle = online ? C.online : '#2f3a4a';
    ctx.lineWidth = 1.3;
    ctx.stroke();

    drawSignalGlyph(n.x, n.y, online);

    ctx.font = '500 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = C.label;
    ctx.fillText(n.deviceId.replace('phone-', ''), n.x, n.y + 33);

    if (pkts > 0) {
      ctx.beginPath();
      ctx.arc(n.x + 15, n.y - 15, 8, 0, Math.PI * 2);
      ctx.fillStyle = C.packet;
      ctx.fill();
      ctx.font = '600 10px JetBrains Mono, monospace';
      ctx.fillStyle = '#fff';
      ctx.fillText(String(pkts), n.x + 15, n.y - 14.5);
    }
  });

  rafId = requestAnimationFrame(draw);
}

// Chrome pauses rAF in a hidden tab anyway; stopping the loop and the poll
// explicitly also stops the 5s request every backgrounded tab would keep making.
function startLoop() { if (rafId === null) rafId = requestAnimationFrame(draw); }
function stopLoop()  { if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; } }
function startPoll() { if (pollId === null) pollId = setInterval(refresh, 5000); }
function stopPoll()  { if (pollId !== null) { clearInterval(pollId); pollId = null; } }

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopLoop(); stopPoll(); }
  else { startLoop(); startPoll(); refresh(); }
});

// ─── Drag ────────────────────────────────────────────────────────────────────
function pointAt(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
canvas.addEventListener('pointerdown', e => {
  const p = pointAt(e);
  for (const n of nodes) {
    if (Math.hypot(p.x - n.x, p.y - n.y) < 24) {
      dragNode = n; dragOffX = p.x - n.x; dragOffY = p.y - n.y;
      canvas.classList.add('grabbing');
      canvas.setPointerCapture(e.pointerId);
      break;
    }
  }
});
canvas.addEventListener('pointermove', e => {
  const p = pointAt(e);
  if (dragNode) {
    dragNode.x = Math.max(24, Math.min(viewW() - 24, p.x - dragOffX));
    dragNode.y = Math.max(24, Math.min(viewH() - 24, p.y - dragOffY));
    return;
  }
  hoverNode = nodes.find(n => Math.hypot(p.x - n.x, p.y - n.y) < 24) || null;
  canvas.style.cursor = hoverNode ? 'grab' : 'default';
});
canvas.addEventListener('pointerleave', () => { hoverNode = null; });
function endDrag() { dragNode = null; canvas.classList.remove('grabbing'); }
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// ─── Packet animation ────────────────────────────────────────────────────────
function animateTransfer(fromId, toId, color) {
  const from = nodes.find(n => n.deviceId === fromId);
  const to = nodes.find(n => n.deviceId === toId);
  if (!from || !to) return;
  animations.push({
    fromX: from.x, fromY: from.y, toX: to.x, toY: to.y,
    start: Date.now() + Math.random() * 250,
    duration: 550 + Math.random() * 350,
    color: color || C.packet
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
// Device names come from a text input, so anything interpolated into innerHTML
// gets escaped first.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function icon(id, cls) {
  return `<svg class="icon ${cls || 'icon-sm'}" aria-hidden="true"><use href="#${id}"/></svg>`;
}

// ─── API ─────────────────────────────────────────────────────────────────────
async function api(url, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${method} ${url} -> HTTP ${r.status}`);
  return r.json();
}

// ─── Dependency strip ────────────────────────────────────────────────────────
function setDep(id, state, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.dataset.state = state;
  const val = el.querySelector('.dep-val');
  if (val) val.textContent = value;
}

let stateResetId = null;
function setState(text, kind = '') {
  const el = document.getElementById('stState');
  if (!el) return;
  el.textContent = text;
  el.dataset.state = kind;
  clearTimeout(stateResetId);
  if (kind !== 'down') {
    stateResetId = setTimeout(() => {
      el.textContent = 'idle';
      el.dataset.state = '';
    }, 2500);
  }
}

// ─── Refresh ─────────────────────────────────────────────────────────────────
let refreshFailures = 0;
let storeAnnounced = false;

function logRefreshFailure(e) {
  refreshFailures++;
  // refresh() polls every 5s. Log the first failure, then once a minute, so an
  // outage reports itself without flooding the log pane.
  if (refreshFailures === 1 || refreshFailures % 12 === 0) {
    logMsg(`backend unreachable (${e.message}), showing last known state`, 'throttled');
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
    setDep('depMesh', 'down', 'down');
  }

  if (state) {
    // Both backends are fully functional; redis only widens the guarantee from
    // one instance to the cluster. So this reports which one is live, not health.
    const store = state.store || 'memory';
    setDep('depStore', 'up', store);
    if (!storeAnnounced) {
      storeAnnounced = true;
      logMsg(store === 'redis'
        ? 'store: redis — idempotency, rate limiting and queue are distributed'
        : 'store: in-memory — single instance, no external services required');
    }

    const deviceData = state.devices || [];
    deviceData.forEach(d => {
      let n = nodes.find(nd => nd.deviceId === d.deviceId);
      if (n) {
        n.hasInternet = d.hasInternet;
        n.packetCount = d.packetCount;
        n.packetIds = d.packetIds;
      } else {
        nodes.push({ deviceId: d.deviceId, hasInternet: d.hasInternet,
                     packetCount: d.packetCount, packetIds: d.packetIds });
      }
    });
    nodes = nodes.filter(n => deviceData.some(d => d.deviceId === n.deviceId));
    layoutNodes();
    updateDeviceList();

    const inFlight = nodes.reduce((s, n) => s + (n.packetCount || 0), 0);
    const bridges = nodes.filter(n => n.hasInternet).length;
    setText('mPackets', inFlight);
    setText('mBridges', bridges);
    setText('mDedup', state.idempotencyCacheSize ?? 0);
    setText('mQueue', state.queueDepth ?? 0);
    setDep('depMesh', 'up', nodes.length + 'n');
  }

  // Balances and the ledger come from Postgres and are independent of the mesh
  // endpoint — keep them refreshing even when the mesh poll fails.
  updateAccounts();
  updateTransactions();
}

function setText(id, v) {
  const el = document.getElementById(id);
  if (el) el.textContent = v;
}

function updateDeviceList() {
  const el = document.getElementById('deviceList');
  if (!el) return;
  setText('deviceCount', nodes.length ? nodes.length : '');
  if (!nodes.length) {
    el.innerHTML = '<tr class="empty"><td colspan="3">no nodes</td></tr>';
    return;
  }
  el.innerHTML = nodes.map(n => {
    const id = esc(n.deviceId);
    const name = esc(n.deviceId.replace('phone-', ''));
    const pkts = n.packetCount || 0;
    return `<tr>
      <td><i class="n-dot ${n.hasInternet ? 'on' : ''}"></i><span class="n-name">${name}</span></td>
      <td class="num n-pkts ${pkts ? 'hot' : ''}">${pkts}</td>
      <td class="act">
        <button class="rowbtn" onclick="toggleInternet('${id}')"
                title="${n.hasInternet ? 'take offline' : 'bring online'}"
                aria-label="${n.hasInternet ? 'Take ' + name + ' offline' : 'Bring ' + name + ' online'}">
          ${icon(n.hasInternet ? 'i-offline' : 'i-online')}</button>
        <button class="rowbtn danger" onclick="removeDevice('${id}')"
                title="remove" aria-label="Remove ${name}">${icon('i-x')}</button>
      </td>
    </tr>`;
  }).join('');
}

async function updateAccounts() {
  try {
    const accs = await api('/api/accounts');
    setDep('depDb', 'up', 'ok');
    const el = document.getElementById('accountList');
    if (!el) return;
    el.innerHTML = accs.map(a => `<tr>
        <td>${esc(a.holderName)}</td>
        <td class="vpa">${esc(a.vpa)}</td>
        <td class="num bal">${Number(a.balance).toFixed(2)}</td>
      </tr>`).join('');
  } catch (e) {
    setDep('depDb', 'down', 'down');
  }
}

async function updateTransactions() {
  try {
    const txs = await api('/api/transactions');
    const el = document.getElementById('txList');
    if (!el) return;
    setText('txCount', txs && txs.length ? txs.length : '');
    setText('mSettled', txs ? txs.length : 0);
    if (!txs || !txs.length) {
      el.innerHTML = '<tr class="empty"><td colspan="3">nothing settled</td></tr>';
      return;
    }
    el.innerHTML = txs.slice(0, 10).map(tx => `<tr>
        <td>${esc(tx.senderVpa.split('@')[0])}</td>
        <td>${esc(tx.receiverVpa.split('@')[0])}</td>
        <td class="num amt">${Number(tx.amount).toFixed(0)}</td>
      </tr>`).join('');
  } catch (e) { /* the dependency strip already reports the outage */ }
}

// ─── Actions ─────────────────────────────────────────────────────────────────
async function sendPacket() {
  const senderVpa = document.getElementById('senderVpa').value;
  const receiverVpa = document.getElementById('receiverVpa').value;
  const amount = parseFloat(document.getElementById('amount').value);
  const pin = document.getElementById('pin').value;
  try {
    const r = await api('/api/demo/send', 'POST', { senderVpa, receiverVpa, amount, pin });
    logMsg(`packet ${r.packetId.substring(0, 8)} sealed, injected at ${r.injectedAt} ttl=${r.ttl}`, 'accepted');
    toast('RSA-2048 + AES-256-GCM');
    setState('injected');
    refresh();
  } catch (e) {
    logMsg(`Inject failed (${e.message})`, 'throttled');
  }
}

async function gossip() {
  try {
    // Only devices within BLE range of each other may exchange packets.
    const neighbors = {};
    nodes.forEach(n => { neighbors[n.deviceId] = []; });
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        if (Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y) <= bluetoothRange * 2) {
          neighbors[nodes[i].deviceId].push(nodes[j].deviceId);
          neighbors[nodes[j].deviceId].push(nodes[i].deviceId);
        }
      }
    }
    const r = await api('/api/mesh/gossip', 'POST', neighbors);
    logMsg(`gossip: ${r.transfers} transfer(s)`);
    setState(`gossip ${r.transfers}`);
    if (r.transfers > 0) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          if (Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y) <= bluetoothRange * 2) {
            animateTransfer(nodes[i].deviceId, nodes[j].deviceId);
            animateTransfer(nodes[j].deviceId, nodes[i].deviceId);
          }
        }
      }
    }
    refresh();
  } catch (e) {
    logMsg(`Gossip failed (${e.message})`, 'throttled');
  }
}

async function flushBridges() {
  try {
    const r = await api('/api/mesh/flush', 'POST');
    logMsg(`flush: ${r.uploadsAttempted} bridge upload(s)`);
    setState('flushing', 'busy');
    r.results.forEach(res => {
      const isVip = res.hopCount === 0;
      const cls = res.outcome === 'ACCEPTED_FOR_PROCESSING' ? 'accepted'
                : res.outcome === 'THROTTLED' ? 'throttled'
                : res.outcome === 'DUPLICATE_DROPPED' ? 'duplicate' : 'throttled';
      logMsg(`  [${res.bridgeNode}] ${res.packetId} ${res.outcome}${isVip ? ' VIP' : ''}`,
             isVip && cls === 'accepted' ? 'vip' : cls);
      if (res.outcome === 'ACCEPTED_FOR_PROCESSING') {
        const bn = nodes.find(n => n.deviceId === res.bridgeNode);
        if (bn) {
          animations.push({
            fromX: bn.x, fromY: bn.y, toX: bn.x, toY: bn.y - 110,
            start: Date.now(), duration: 900, color: C.online
          });
        }
      }
    });
    logMsg('  worker decrypting');
    setTimeout(refresh, 1500);
  } catch (e) {
    logMsg(`Flush failed (${e.message})`, 'throttled');
  }
}

async function resetMesh() {
  try {
    await api('/api/mesh/reset', 'POST');
    logMsg('reset: mesh, dedup cache, queue and ledger cleared');
    setState('reset');
    nodes.forEach(n => { n.packetCount = 0; n.packetIds = []; });
  } catch (e) {
    // Reset clears the Redis dedup cache and queue first, so it fails as a unit
    // whenever Redis is down.
    logMsg(`reset failed (${e.message})`, 'throttled');
  }
  refresh();
}

async function toggleInternet(deviceId) {
  try {
    await api(`/api/mesh/device/${encodeURIComponent(deviceId)}/toggle-internet`, 'POST');
    const n = nodes.find(nd => nd.deviceId === deviceId);
    logMsg(`${deviceId} is now ${n && !n.hasInternet ? 'ONLINE' : 'OFFLINE'}`);
  } catch (e) {
    logMsg(`Could not toggle ${deviceId} (${e.message})`, 'throttled');
  }
  refresh();
}

async function addDeviceFromForm() {
  const input = document.getElementById('newDeviceId');
  const raw = input.value.trim();
  if (!raw) return;
  const id = 'phone-' + raw.toLowerCase().replace(/\s+/g, '-');
  try {
    await api('/api/mesh/device/add', 'POST', { deviceId: id, hasInternet: false });
    input.value = '';
    logMsg(`Added ${id}`);
  } catch (e) {
    logMsg(`Could not add ${id} (${e.message})`, 'throttled');
  }
  refresh();
}

async function removeDevice(deviceId) {
  try {
    await api(`/api/mesh/device/${encodeURIComponent(deviceId)}/remove`, 'POST');
    logMsg(`Removed ${deviceId}`);
  } catch (e) {
    logMsg(`Could not remove ${deviceId} (${e.message})`, 'throttled');
  }
  refresh();
}

// ─── Log ─────────────────────────────────────────────────────────────────────
function logMsg(msg, cls = '') {
  const el = document.getElementById('activityLog');
  if (!el) return;
  const div = document.createElement('div');
  div.className = 'log-entry' + (cls ? ' ' + cls : '');
  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
  div.appendChild(ts);
  div.appendChild(document.createTextNode(msg));
  el.prepend(div);
  while (el.children.length > 100) el.removeChild(el.lastChild);
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ─── Range ───────────────────────────────────────────────────────────────────
function updateRange(val) {
  bluetoothRange = parseInt(val, 10);
  setText('rangeVal', val);
  rangeRevealUntil = Date.now() + 1400;   // show every ring while the user tunes
}

// Real consoles are driven from the keyboard. Ignore the shortcut while the
// user is typing into a field.
const KEYS = { i: sendPacket, g: gossip, f: flushBridges, r: resetMesh };
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  const fn = KEYS[e.key.toLowerCase()];
  if (fn) { e.preventDefault(); fn(); }
});

// ─── Init ────────────────────────────────────────────────────────────────────
refresh();
startLoop();
startPoll();
