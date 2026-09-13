const $ = (s) => document.querySelector(s);
let data = null,
  view = 'overview',
  filter = '',
  pending = false;
const esc = (x) =>
  String(x ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const num = (x) =>
  x == null ? '—' : Number(x).toLocaleString(undefined, { maximumFractionDigits: 1 });
const bytes = (x) =>
  x == null
    ? '—'
    : x >= 1024 ** 3
      ? `${(x / 1024 ** 3).toFixed(1)} GiB`
      : x >= 1024 ** 2
        ? `${(x / 1024 ** 2).toFixed(1)} MiB`
        : `${num(x)} B`;
const age = (x) => {
  if (!x) return 'Unknown';
  const sec = Math.max(0, (Date.now() - new Date(x).getTime()) / 1000);
  return sec < 60
    ? 'Just now'
    : sec < 3600
      ? `${Math.floor(sec / 60)}m ago`
      : `${Math.floor(sec / 3600)}h ago`;
};
const badge = (text, kind = '') => `<span class="badge ${kind}">${esc(text)}</span>`;
const good = () => data.workers.filter((w) => w.reachable);
const rows = () =>
  data.workers.flatMap((w) => (w.residents || []).map((r) => ({ ...r, worker: w })));
const counters = () => {
  const out = {};
  for (const w of good())
    for (const c of Object.values(w.metrics?.buckets || {}))
      for (const [k, v] of Object.entries(c)) out[k] = (out[k] || 0) + v;
  return out;
};
async function api(route, body) {
  const r = await fetch(`/ops/api/${route}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json', 'X-Ops-CSRF': data?.csrf || '' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const result = await r.json();
  if (!r.ok) {
    if (r.status === 401 && route !== 'login') showLogin();
    throw Error(result.error || 'Request failed');
  }
  return result;
}
function showLogin() {
  $('#login').hidden = false;
  $('#app').hidden = true;
}
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  setTimeout(() => ($('#toast').hidden = true), 8000);
}
async function refresh() {
  if (pending) return;
  pending = true;
  $('#refresh').disabled = true;
  try {
    data = await api('state');
    $('#login').hidden = true;
    $('#app').hidden = false;
    render();
  } catch (e) {
    if (data) {
      $('#banner').textContent = `Refresh failed. Displaying the last sample: ${e.message}`;
      $('#banner').hidden = false;
      $('#connection').textContent = 'Connection lost';
    } else if (e.message !== 'Sign in to view fleet status')
      $('#login-error').textContent = e.message;
  } finally {
    pending = false;
    $('#refresh').disabled = false;
  }
}
function stats() {
  const live = good(),
    c = counters(),
    res = rows().filter((r) => r.resident),
    total = live.reduce((n, w) => n + w.totalBytes, 0),
    free = live.reduce((n, w) => n + w.freeBytes, 0);
  return `<div class="stats"><div class="stat"><div class="stat-label">Workers online</div><div class="stat-value">${live.length} <small>/ ${data.workers.length}</small></div><div class="stat-note">${live.filter((w) => w.accepting && w.freeSlots > 0).length} with available admission slots</div></div><div class="stat"><div class="stat-label">Resident workspaces</div><div class="stat-value">${res.length}</div><div class="stat-note">${new Set(res.map((r) => `${r.tenantId}/${r.branchId}`)).size} distinct branches across the fleet</div></div><div class="stat"><div class="stat-label">Local disk used</div><div class="stat-value">${live.length ? bytes(total - free) : '—'}</div><div class="stat-note">${bytes(free)} available · includes non-workspace files</div></div><div class="stat"><div class="stat-label">S3 calls · current worker processes</div><div class="stat-value">${num(live.length ? (c.getCalls || 0) + (c.putCalls || 0) : null)}</div><div class="stat-note">${num(c.getCalls || 0)} GET · ${num(c.putCalls || 0)} PUT · SDK calls, excluding retries</div></div></div>`;
}
function workerCard(w) {
  const healthy = w.reachable;
  const status = !healthy
    ? 'Unreachable'
    : w.hold
      ? 'Operator hold'
      : w.maintenanceRunning
        ? 'Maintenance'
        : w.freeSlots > 0
          ? 'Ready'
          : 'At capacity';
  const disk = healthy ? 100 * (1 - w.freeBytes / w.totalBytes) : 0,
    mem = healthy ? 100 * (1 - w.hostMemory.free / w.hostMemory.total) : 0;
  return `<article class="worker"><div class="worker-top"><div><h3><span class="host-icon">▤</span>${esc(w.name)}</h3><div class="meta mono">${esc(w.id)}</div></div>${badge(status, !healthy ? 'bad' : w.hold || !w.freeSlots ? 'warn' : 'good')}</div><div class="worker-body"><div class="meta">${esc(w.type)} · ${esc(w.az)} · ${esc(w.origin.replace('http://', ''))}</div>${healthy ? `<div class="usage"><div><div class="meter-label"><span>Disk</span><span>${disk.toFixed(0)}%</span></div><progress max="100" value="${disk}"></progress></div><div><div class="meter-label"><span>Memory¹</span><span>${mem.toFixed(0)}%</span></div><progress max="100" value="${mem}"></progress></div></div><div class="inline-metrics"><span><strong>${w.residents.filter((r) => r.resident).length}</strong> workspaces</span><span><strong>${w.activeSessions}</strong> active sessions</span><span><strong>${w.freeSlots}</strong> free slots</span></div>` : `<p class="error">${esc(w.error)}</p>`}</div><div class="worker-bottom"><span>${healthy ? `◈ ${esc(w.cachePolicy?.mode || 'Legacy placement')}` : 'Status unavailable'}</span><button data-worker="${esc(w.id)}">Inspect worker ↗</button></div></article>`;
}
function fleet() {
  return `<div class="section-head"><div><h2>Worker placement</h2><p>Real worker responses. Select a host to inspect capacity and its local state.</p></div>${badge('XFS · reflink')}</div><div class="fleet">${data.workers.length ? data.workers.map(workerCard).join('') : '<p>Discovering EC2 workers…</p>'}</div>`;
}
function chart(metric) {
  if (!metric?.points?.length)
    return '<div class="chart-empty">No CloudWatch samples yet. Request metrics are not backfilled.</div>';
  const points = metric.points,
    maximum = Math.max(1, ...points.map((p) => p[1]));
  return `<svg class="chart" viewBox="0 0 600 96" preserveAspectRatio="none" role="img" aria-label="S3 GET requests over the last hour"><polyline points="${points.map((p, i) => `${(i * 600) / Math.max(points.length - 1, 1)},${90 - (p[1] / maximum) * 78}`).join(' ')}"/></svg>`;
}
function storagePanel() {
  const cloud = data.cloud,
    c = counters();
  return `<section class="panel"><div class="storage-title"><h2>Object storage</h2>${badge('S3')}</div><div class="bucket mono">${esc(data.bucket)}</div><p>Worker traffic since each controller last started</p><div class="storage-numbers"><div><strong>${num(good().length ? c.putCalls || 0 : null)}</strong><span>PUT calls</span></div><div><strong>${num(good().length ? c.getCalls || 0 : null)}</strong><span>GET calls</span></div><div><strong>${num(good().length ? (c.getCacheHits || 0) + (c.putCacheHits || 0) : null)}</strong><span>Local cache hits</span></div></div>${chart(cloud?.metrics?.find((m) => m.name === 'GetRequests'))}<div class="legend"><span>Bucket GET requests · last hour</span><span>${cloud?.error ? 'CloudWatch unavailable' : 'CloudWatch · 5-minute periods'}</span></div></section>`;
}
function event(op) {
  return `<div class="event"><span class="event-icon">${op.kind === 'transfer' ? '↔' : op.kind === 'release' ? '◇' : '＋'}</span><div><strong>${esc(op.kind === 'transfer' ? 'Workspace transfer' : op.kind === 'release' ? 'Worker released' : 'Provision worker')} ${badge(op.status, op.status === 'complete' ? 'good' : ['failed', 'interrupted'].includes(op.status) ? 'bad' : 'warn')}</strong><p>${esc(op.detail)}</p><small>${esc(age(op.updatedAt || op.createdAt))} · ${esc(op.id)}</small></div></div>`;
}
function events(limit = 4) {
  return data.operations.length
    ? data.operations.slice(0, limit).map(event).join('')
    : '<div class="empty">No operator actions yet.<br>Transfers and provisioning will appear here.</div>';
}
function workspaceTable() {
  const matches = rows().filter((r) =>
    `${r.repository} ${r.branchId} ${r.tenantId} ${r.worker.name}`
      .toLowerCase()
      .includes(filter.toLowerCase())
  );
  return `<div class="table-wrap"><table><thead><tr><th>Repository / branch</th><th>Worker</th><th>Local state</th><th>Revision</th><th>Sessions²</th><th>Last used</th><th></th></tr></thead><tbody>${matches.map((r) => `<tr><td><strong>${esc(r.repository.split('/').slice(-2).join('/'))}</strong><small class="mono">${esc(r.branchId)} · tenant ${esc(r.tenantId)}</small></td><td>${esc(r.worker.name)}</td><td>${badge(r.pinned ? 'Pinned' : r.resident ? 'Resident' : 'Evicted', r.pinned ? 'warn' : r.resident ? 'good' : '')}${r.stale ? '<small>Recorded stale copy</small>' : ''}</td><td>${num(r.revision)}</td><td>${r.sessions.length}</td><td>${esc(age(r.lastUsed))}</td><td>${r.resident ? `<button class="row-action" data-transfer="${esc(r.worker.id)}" data-tenant="${esc(r.tenantId)}" data-branch="${esc(r.branchId)}">Transfer ↗</button>` : '—'}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No recorded workspaces match this view.</td></tr>'}</tbody></table></div>`;
}
function render() {
  const titles = {
    overview: ['Workspace fleet', 'Local speed. A clear view of where everything lives.'],
    workspaces: [
      'Workspace residency',
      'Inspect local branch copies and move idle workspaces between workers.',
    ],
    storage: [
      'Storage & request traffic',
      'Worker-level counters alongside bucket-wide CloudWatch measurements.',
    ],
    operations: [
      'Fleet operations',
      'A durable record of operator requests, progress and recovery holds.',
    ],
  };
  $('#title').textContent = titles[view][0];
  $('#subtitle').textContent = titles[view][1];
  $('#crumb').textContent =
    view === 'overview' ? 'Overview' : view[0].toUpperCase() + view.slice(1);
  const stale =
    data.collectionError || !data.sampledAt || Date.now() - new Date(data.sampledAt) > 45000;
  $('#connection').textContent = stale ? 'Sample stale' : 'Live telemetry';
  $('#banner').hidden = !stale;
  if (stale)
    $('#banner').textContent =
      data.collectionError || 'Waiting for worker samples. Missing data is not zero usage.';
  $('#op-count').textContent = data.operations.filter((o) =>
    ['running', 'queued'].includes(o.status)
  ).length;
  $('#updated').textContent = data.sampledAt
    ? `Last fleet sample ${new Date(data.sampledAt).toLocaleTimeString()}`
    : 'Waiting for the first live sample';
  let html = '';
  if (view === 'overview')
    html =
      stats() +
      fleet() +
      `<div class="grid-two">${storagePanel()}<section class="panel"><div class="section-head"><h2>Recent operations</h2><button data-view="operations" class="row-action">View all</button></div>${events()}</section></div><div class="section-head"><h2>Workspace residency</h2><button data-view="workspaces" class="row-action">View workspaces</button></div>` +
      workspaceTable();
  if (view === 'workspaces')
    html = `<div class="section-head"><p>Inventory is recorded residency, not a live ownership assertion. ² Session counts are stored replicas.</p><input class="search" id="search" placeholder="Search repo, branch or tenant" value="${esc(filter)}" aria-label="Search workspaces"></div><div id="workspace-table">${workspaceTable()}</div>`;
  if (view === 'storage') {
    const c = counters();
    html = `<div class="grid-two">${storagePanel()}<section class="panel"><h2>Worker transfer counters</h2>${[
      ['Compressed bytes uploaded', bytes(c.uploadedBytes)],
      ['Compressed bytes downloaded', bytes(c.downloadedBytes)],
      ['GET errors', num(c.getErrors || 0)],
      ['PUT errors (includes precondition responses)', num(c.putErrors || 0)],
      ['GET cache hits', num(c.getCacheHits || 0)],
      ['PUTs avoided by cache', num(c.putCacheHits || 0)],
    ]
      .map(([k, v]) => `<div class="detail-row"><span>${k}</span><span>${v}</span></div>`)
      .join(
        ''
      )}<p>These counters cover controller blob calls. They exclude SDK retry attempts and daemon uploads; they reset when a worker process restarts.</p></section></div><section class="panel"><h2>CloudWatch · bucket-wide</h2><p>Last hour. Delayed, best-effort request metrics; not billing-grade. Blank values mean no samples.</p>${data.cloud?.error ? `<p class="error">${esc(data.cloud.error)}</p>` : (data.cloud?.metrics || []).map((m) => `<div class="detail-row"><span>${esc(m.name)}</span><span>${m.name.startsWith('Bytes') ? bytes(m.value) : num(m.value)}${m.name.includes('Latency') ? ' ms' : ''}</span></div>`).join('')}<p>First-byte latency is the mean of available five-minute averages.</p></section>`;
  }
  if (view === 'operations')
    html = `<div class="grid-two"><section class="panel"><h2>Operation history</h2>${events(50)}</section><section class="panel"><h2>Worker holds</h2><p>Failed transfers retain holds until inspected. Releasing a hold permits new work; it does not retry or complete a transfer.</p>${
      data.workers
        .filter((w) => w.hold)
        .map(
          (w) =>
            `<div class="event"><div><strong>${esc(w.name)}</strong><p class="mono">${esc(w.hold)}</p><button data-release="${esc(w.id)}" ${w.operationRunning ? 'disabled' : ''}>Review release</button></div></div>`
        )
        .join('') || '<div class="empty">No workers held by an operator.</div>'
    }</section></div>`;
  $('#content').innerHTML = html;
  document.querySelectorAll('.nav').forEach((n) => {
    n.classList.toggle('active', n.dataset.view === view);
  });
  const search = $('#search');
  if (search)
    search.oninput = () => {
      filter = search.value;
      $('#workspace-table').innerHTML = workspaceTable();
    };
}
function modal(html) {
  $('#modal-content').innerHTML = html;
  $('#modal').showModal();
}
function inspect(id) {
  const w = data.workers.find((w) => w.id === id);
  modal(
    `<h2>${esc(w.name)}</h2><p class="mono">${esc(w.id)}</p>${[
      ['Instance type', w.type],
      ['Availability zone', w.az],
      ['Origin', w.origin],
      ['Runtime image', w.image || 'Unavailable'],
      ['Policy', w.cachePolicy?.mode || 'Unavailable'],
      ['Available disk', bytes(w.freeBytes)],
      ['Free inodes', num(w.freeInodes)],
      ['Load average (1 / 5 / 15m)', w.load?.map((x) => x.toFixed(2)).join(' / ') || 'Unavailable'],
      ['CPU cores', num(w.cpuCount)],
      ['Admission slots', `${num(w.freeSlots)} / ${num(w.maximumSessions)}`],
      ['Counter start', w.metrics?.startedAt || 'Unavailable'],
      ['Operator hold', w.hold || 'None'],
    ]
      .map(([k, v]) => `<div class="detail-row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`)
      .join(
        ''
      )}<p>¹ Memory shows total minus OS free memory, including filesystem cache. Disk covers the entire filesystem, not just Agor.</p>`
  );
}
function transferDialog(source, tenant, branch) {
  const w = data.workers.find((w) => w.id === source);
  const targets = good().filter((t) => t.id !== source);
  modal(
    `<h2>Transfer workspace</h2><p>Move the private workspace through an acknowledged S3 checkpoint. Source files are retained.</p><div class="review"><strong>${esc(w.name)}</strong><div class="mono">${esc(branch)}<br>tenant ${esc(tenant)}</div></div><label for="destination">Destination worker</label><select id="destination">${targets.map((t) => `<option value="${esc(t.id)}">${esc(t.name)} · ${bytes(t.freeBytes)} free${t.activeSessions ? ' · active' : ''}</option>`).join('')}</select><div class="review"><ol><li>Hold both workers. Active tasks or maintenance cause a refusal.</li><li>Checkpoint source files and restore on the destination.</li><li>Verify, then release both workers. Affinity prefers the restored copy.</li></ol>This pauses admission on both hosts while transferring. Existing destination replicas are retained separately; no automatic cleanup.</div><p id="action-error" class="error" role="alert"></p><div class="modal-actions"><button id="cancel">Cancel</button><button id="confirm" class="primary" ${targets.length ? '' : 'disabled'}>Transfer workspace</button></div>`
  );
  $('#cancel').onclick = () => $('#modal').close();
  $('#confirm').onclick = () =>
    submit('transfer', { source, target: $('#destination').value, tenant, branch });
}
async function submit(route, payload) {
  $('#confirm').disabled = true;
  try {
    await api(route, payload);
    $('#modal').close();
    view = 'operations';
    await refresh();
    toast('Operation accepted. Follow its progress in Operations.');
  } catch (e) {
    $('#action-error').textContent = e.message;
    $('#confirm').disabled = false;
  }
}
$('#provision').onclick = () => {
  modal(
    `<h2>Add an EC2 worker</h2><p>Provision one m7i.xlarge in the existing isolated VPC.</p><div class="review"><div class="detail-row"><span>Compute</span><span>4 vCPU · 16 GiB RAM</span></div><div class="detail-row"><span>Storage</span><span>150 GiB encrypted gp3 / XFS</span></div><div class="detail-row"><span>Region</span><span>${esc(data.region)}</span></div><div class="detail-row"><span>Additional fleet limit</span><span>${data.maxAdditionalWorkers} workers</span></div></div><p>This starts billable EC2 and EBS resources. The Terraform-managed Auto Scaling group boots the pinned runtime; the dispatcher discovers it after health checks. No automatic scale-down is enabled.</p><p id="action-error" class="error" role="alert"></p><div class="modal-actions"><button id="cancel">Cancel</button><button id="confirm" class="primary">Provision worker</button></div>`
  );
  $('#cancel').onclick = () => $('#modal').close();
  $('#confirm').onclick = () => submit('provision', {});
};
document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.view) {
    view = b.dataset.view;
    render();
  }
  if (b.dataset.worker) inspect(b.dataset.worker);
  if (b.dataset.transfer) transferDialog(b.dataset.transfer, b.dataset.tenant, b.dataset.branch);
  if (b.dataset.release) {
    const w = data.workers.find((w) => w.id === b.dataset.release);
    modal(
      `<h2>Release worker hold?</h2><p>${esc(w.name)} will accept work again. This does not complete the failed transfer. Check operation history and destination state first.</p><p class="mono">${esc(w.hold)}</p><p id="action-error" class="error"></p><div class="modal-actions"><button id="confirm" class="primary">Release hold</button></div>`
    );
    $('#confirm').onclick = () => submit('release', { worker: w.id });
  }
});
$('#refresh').onclick = refresh;
$('#logout').onclick = async () => {
  await api('logout', {});
  data = null;
  showLogin();
};
$('#login-form').onsubmit = async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  const b = e.target.querySelector('button');
  b.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(e.target));
    await api('login', values);
    e.target.password.value = '';
    await refresh();
  } catch (err) {
    $('#login-error').textContent = err.message;
  } finally {
    b.disabled = false;
  }
};
refresh();
setInterval(() => {
  if (!$('#app').hidden && !$('#modal').open) refresh();
}, 15000);
