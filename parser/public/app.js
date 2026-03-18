/* ===== Amazon Parser — Frontend SPA ===== */

const App = (function () {
  'use strict';

  let currentJobId = null;
  let currentPage = 1;
  const PAGE_LIMIT = 50;
  let pollTimer = null;
  let selectedFile = null;

  // ---- API ----
  function getToken() { return localStorage.getItem('token'); }

  async function api(path, opts = {}) {
    const token = getToken();
    if (!token) { goLogin(); throw new Error('No token'); }

    const headers = { ...(opts.headers || {}), 'Authorization': 'Bearer ' + token };
    if (!(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';

    const res = await fetch(path, { ...opts, headers });
    if (res.status === 401) { goLogin(); throw new Error('Unauthorized'); }
    if (opts.raw) return res;

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'API Error');
    return data;
  }

  function goLogin() {
    localStorage.removeItem('token');
    window.location.href = 'login.html';
  }

  // ---- Router ----
  function navigate(route, id, subId) {
    if (route === 'dashboard') window.location.hash = '#dashboard';
    else if (route === 'job') window.location.hash = '#job/' + id;
    else if (route === 'item') window.location.hash = '#job/' + id + '/item/' + subId;
  }

  function handleRoute() {
    const hash = window.location.hash || '#dashboard';
    const parts = hash.replace('#', '').split('/');
    stopPolling();
    hideAllViews();

    if (parts[0] === 'job' && parts[2] === 'item' && parts[3]) {
      currentJobId = parts[1];
      showView('item');
      loadItemDetail(parts[1], parts[3]);
    } else if (parts[0] === 'job' && parts[1]) {
      currentJobId = parts[1];
      currentPage = 1;
      showView('job');
      loadJobDetail();
      startPolling();
    } else {
      currentJobId = null;
      showView('dashboard');
      loadDashboard();
    }
  }

  function hideAllViews() { document.querySelectorAll('.view').forEach(v => v.style.display = 'none'); }
  function showView(name) { const el = document.getElementById('view-' + name); if (el) el.style.display = 'block'; }

  // ---- Dashboard ----
  async function loadDashboard() {
    try {
      const [stats, jobs] = await Promise.all([api('/api/stats'), api('/api/jobs')]);
      setText('stat-jobs', fmtNum(stats.totalJobs));
      setText('stat-items', fmtNum(stats.totalItems));
      setText('stat-parsed', fmtNum(stats.parsedItems));
      setText('stat-errors', fmtNum(stats.errorItems));
      renderJobsTable(Array.isArray(jobs) ? jobs : []);
    } catch (err) { console.error('Dashboard error:', err); }
  }

  function renderJobsTable(jobs) {
    const tbody = document.getElementById('jobsTableBody');
    if (!jobs.length) {
      tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><div class="empty-state-icon">&#128230;</div><h3>No jobs yet</h3><p>Click "+ New Job" to get started.</p></div></td></tr>';
      return;
    }
    tbody.innerHTML = jobs.map(j => {
      const total = j.total_items || 0;
      const done = (j.parsed_items || 0) + (j.error_items || 0);
      const pct = total > 0 ? Math.round(done / total * 100) : 0;
      return `<tr class="clickable" onclick="App.navigate('job','${j.id}')">
        <td><strong>${esc(j.name)}</strong></td>
        <td>${statusBadge(j.status)}</td>
        <td><div style="min-width:120px"><div class="progress"><div class="progress-bar ${pct===100?'progress-success':''}" style="width:${pct}%"></div></div><div class="progress-info"><span>${j.parsed_items||0}/${total}</span><span>${pct}%</span></div></div></td>
        <td>${j.speed||'-'}/hr</td>
        <td>${fmtDate(j.created_at)}</td>
        <td style="text-align:right"><div class="btn-group" style="justify-content:flex-end" onclick="event.stopPropagation()">
          ${j.status==='pending'||j.status==='paused'?`<button class="btn btn-success btn-sm" onclick="App.doJobAction('${j.id}','start')">Start</button>`:''}
          ${j.status==='running'?`<button class="btn btn-warning btn-sm" onclick="App.doJobAction('${j.id}','pause')">Pause</button>`:''}
          ${j.status!=='stopped'&&j.status!=='done'?`<button class="btn btn-danger btn-sm" onclick="App.doJobAction('${j.id}','stop')">Stop</button>`:''}
          <button class="btn btn-outline btn-sm" onclick="App.deleteJob('${j.id}')">Del</button>
        </div></td></tr>`;
    }).join('');
  }

  // ---- Job Detail ----
  async function loadJobDetail() {
    try {
      const [job, itemsData] = await Promise.all([
        api('/api/jobs/' + currentJobId),
        api('/api/jobs/' + currentJobId + '/items?page=' + currentPage + '&limit=' + PAGE_LIMIT)
      ]);
      renderJobHeader(job);
      renderItemsTable(itemsData);
    } catch (err) { console.error('Job detail error:', err); toast('Load failed: ' + err.message, 'error'); }
  }

  function renderJobHeader(j) {
    document.getElementById('jobBreadcrumb').textContent = j.name;
    const total = j.total_items||0, parsed = j.parsed_items||0, errors = j.error_items||0;
    const pct = total > 0 ? Math.round((parsed+errors)/total*100) : 0;
    let btns = '';
    if (j.status==='pending'||j.status==='paused') btns += `<button class="btn btn-success btn-sm" onclick="App.jobAction('start')">Start</button>`;
    if (j.status==='running') btns += `<button class="btn btn-warning btn-sm" onclick="App.jobAction('pause')">Pause</button>`;
    if (j.status!=='stopped'&&j.status!=='done') btns += `<button class="btn btn-danger btn-sm" onclick="App.jobAction('stop')">Stop</button>`;
    btns += `<button class="btn btn-info btn-sm" onclick="App.exportJob()">Export Excel</button>`;

    document.getElementById('jobHeader').innerHTML = `
      <div class="job-header-top"><h2>${esc(j.name)} ${statusBadge(j.status)}</h2><div class="btn-group">${btns}</div></div>
      <div class="job-meta">
        <div class="job-meta-item"><span class="meta-label">Total</span><span class="meta-value">${total}</span></div>
        <div class="job-meta-item"><span class="meta-label">Parsed</span><span class="meta-value" style="color:var(--success)">${parsed}</span></div>
        <div class="job-meta-item"><span class="meta-label">Errors</span><span class="meta-value" style="color:var(--danger)">${errors}</span></div>
        <div class="job-meta-item"><span class="meta-label">Speed</span><span class="meta-value">${j.speed||'-'}/hr</span></div>
        <div class="job-meta-item"><span class="meta-label">File</span><span class="meta-value">${esc(j.source_file||'-')}</span></div>
      </div>
      <div class="progress progress-lg"><div class="progress-bar ${pct===100?'progress-success':''}" style="width:${pct}%"></div></div>
      <div class="progress-info"><span>${parsed+errors}/${total}</span><span>${pct}%</span></div>`;
  }

  function renderItemsTable(data) {
    const items = data.items || [];
    const tbody = document.getElementById('itemsTableBody');
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="12"><div class="empty-state"><div class="empty-state-icon">&#128269;</div><h3>No items</h3><p>Upload Excel to add SKUs.</p></div></td></tr>';
      renderPagination(0, 1, 1);
      return;
    }
    tbody.innerHTML = items.map(it => {
      const recBadge = recBadgeHtml(it.recommendation, it.status);
      return `<tr class="clickable" onclick="App.navigate('item','${currentJobId}','${it.id}')">
        <td><strong>${esc(it.sku)}</strong></td>
        <td>${esc(it.asin||'-')}</td>
        <td>${esc(it.zoro_qty||'-')}</td>
        <td>${esc(it.amazon_qty||'-')}</td>
        <td>${yesNoBadge(it.competitor_amazon)}</td>
        <td>${fmtPrice(it.zoro_price)}</td>
        <td>${fmtPrice(it.amazon_price)}</td>
        <td>${yesNoBadge(it.seller_is_brand)}</td>
        <td>${yesNoBadge(it.is_oversized)}</td>
        <td>${yesNoBadge(it.is_minority_owned)}</td>
        <td>${it.margin_percent!=null?it.margin_percent+'%':'-'}</td>
        <td>${recBadge}</td></tr>`;
    }).join('');
    renderPagination(data.total, data.page, data.pages);
  }

  function renderPagination(total, page, pages) {
    const c = document.getElementById('itemsPagination');
    if (pages <= 1) { c.innerHTML = ''; return; }
    let h = `<button class="page-btn" ${page<=1?'disabled':''} onclick="App.goPage(${page-1})">&laquo;</button>`;
    const range = pageRange(page, pages);
    for (const p of range) h += p === '...' ? '<span class="page-info">...</span>' : `<button class="page-btn ${p===page?'active':''}" onclick="App.goPage(${p})">${p}</button>`;
    h += `<button class="page-btn" ${page>=pages?'disabled':''} onclick="App.goPage(${page+1})">&raquo;</button><span class="page-info">${total} items</span>`;
    c.innerHTML = h;
  }

  function pageRange(cur, tot) {
    if (tot <= 7) return Array.from({length:tot},(_,i)=>i+1);
    const p = [1];
    if (cur > 3) p.push('...');
    for (let i = Math.max(2,cur-1); i <= Math.min(tot-1,cur+1); i++) p.push(i);
    if (cur < tot-2) p.push('...');
    p.push(tot);
    return p;
  }

  function goPage(p) { currentPage = p; loadJobDetail(); window.scrollTo({top:0,behavior:'smooth'}); }

  // ---- Item Detail ----
  async function loadItemDetail(jobId, itemId) {
    document.getElementById('itemBreadcrumb').innerHTML = `
      <a href="#dashboard">Dashboard</a><span class="separator">/</span>
      <a href="#job/${jobId}">Job #${jobId}</a><span class="separator">/</span>
      <span class="current">Item</span>`;
    const content = document.getElementById('itemDetailContent');
    content.innerHTML = '<div class="loading-overlay"><span class="spinner spinner-lg"></span></div>';
    try {
      const it = await api('/api/jobs/' + jobId + '/items/' + itemId);
      content.innerHTML = `
        <div class="item-images">
          <div class="item-image-box">
            ${it.zoro_image_main ? `<img src="${esc(it.zoro_image_main)}" alt="Zoro" onerror="this.parentElement.innerHTML='<div style=padding:40px;color:var(--text-muted)>No image</div>'">` : '<div style="padding:40px;color:var(--text-muted)">No Zoro image</div>'}
            <div class="image-label">Zoro</div>
          </div>
          <div class="item-image-box">
            ${it.amazon_image_main ? `<img src="${esc(it.amazon_image_main)}" alt="Amazon" onerror="this.parentElement.innerHTML='<div style=padding:40px;color:var(--text-muted)>No image</div>'">` : '<div style="padding:40px;color:var(--text-muted)">No Amazon image</div>'}
            <div class="image-label">Amazon</div>
          </div>
        </div>
        <div class="item-detail-section" style="margin-bottom:24px;text-align:center">
          <h4>Recommendation</h4>
          ${recBadgeHtml(it.recommendation, it.status, true)}
          ${it.margin_percent!=null?`<div style="margin-top:12px;color:var(--text-secondary)">Margin: <strong>${it.margin_percent}%</strong></div>`:''}
        </div>
        <div class="item-detail-grid">
          <div class="item-detail-section">
            <h4>Zoro Data</h4>
            ${dRow('SKU', it.sku)}${dRow('Title', it.zoro_title)}${dRow('Brand', it.zoro_brand)}
            ${dRow('MFR No', it.zoro_mfr_no)}${dRow('UPC', it.zoro_upc)}${dRow('Price', fmtPrice(it.zoro_price))}
            ${dRow('Availability', it.zoro_qty)}
            ${it.zoro_url?dRow('URL', `<a href="${esc(it.zoro_url)}" target="_blank">View</a>`):''}
          </div>
          <div class="item-detail-section">
            <h4>Amazon Data</h4>
            ${dRow('ASIN', it.asin)}${dRow('Title', it.amazon_title)}${dRow('Price', fmtPrice(it.amazon_price))}
            ${dRow('Seller', it.amazon_seller)}${dRow('Rating', it.amazon_rating)}${dRow('Reviews', it.amazon_review_count)}
            ${dRow('BSR', it.amazon_bsr)}${dRow('Weight', it.amazon_weight)}${dRow('Dimensions', it.amazon_dimensions)}
            ${dRow('Availability', it.amazon_qty)}
            ${it.amazon_url?dRow('URL', `<a href="${esc(it.amazon_url)}" target="_blank">View</a>`):''}
          </div>
        </div>
        <div class="item-detail-grid">
          <div class="item-detail-section">
            <h4>Analysis</h4>
            ${dRow('Competitor', yesNoBadge(it.competitor_amazon))}${dRow('Seller=Brand', yesNoBadge(it.seller_is_brand))}
            ${dRow('Oversized', yesNoBadge(it.is_oversized))}${dRow('Minority-Owned', yesNoBadge(it.is_minority_owned))}
            ${dRow('Margin', it.margin_percent!=null?it.margin_percent+'%':'-')}${dRow('AI Model', it.ai_model)}
            ${dRow('Photo Match', it.ai_photo_match)}
          </div>
          <div class="item-detail-section">
            <h4>AI Analysis</h4>
            <div class="analysis-text">${esc(it.ai_analysis || it.ai_recommendation_reason || 'No analysis yet')}</div>
          </div>
        </div>
        ${it.log?`<div class="item-detail-section" style="margin-top:24px"><h4>Log</h4><div class="analysis-text" style="font-size:.8rem;font-family:monospace">${esc(it.log)}</div></div>`:''}
        ${it.error_message?`<div class="alert alert-error" style="margin-top:16px"><strong>Error:</strong> ${esc(it.error_message)}</div>`:''}
        <button class="btn btn-outline" style="margin-top:16px" onclick="App.navigate('job','${jobId}')">&larr; Back</button>`;
    } catch (err) {
      content.innerHTML = `<div class="alert alert-error">Failed to load: ${esc(err.message)}</div>`;
    }
  }

  // ---- Actions ----
  async function jobAction(action) {
    try {
      await api('/api/jobs/' + currentJobId, { method: 'PATCH', body: JSON.stringify({ action }) });
      toast('Job ' + action + ' sent', 'success');
      loadJobDetail();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function doJobAction(id, action) {
    try {
      await api('/api/jobs/' + id, { method: 'PATCH', body: JSON.stringify({ action }) });
      toast('Job ' + action + ' sent', 'success');
      loadDashboard();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function deleteJob(id) {
    if (!confirm('Delete this job and all items?')) return;
    try {
      await api('/api/jobs/' + id, { method: 'DELETE' });
      toast('Job deleted', 'success');
      loadDashboard();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function exportJob() {
    try {
      const res = await fetch('/api/jobs/' + currentJobId + '/export', {
        headers: { 'Authorization': 'Bearer ' + getToken() }
      });
      if (res.status === 401) { goLogin(); return; }
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const cd = res.headers.get('Content-Disposition');
      a.download = cd ? (cd.match(/filename="?([^";\n]+)/)||[])[1]||'export.xlsx' : 'export.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast('Export downloaded', 'success');
    } catch (err) { toast(err.message, 'error'); }
  }

  // ---- New Job ----
  function openNewJobModal() {
    selectedFile = null;
    document.getElementById('jobName').value = '';
    document.getElementById('jobSpeed').value = '50';
    document.getElementById('fileInput').value = '';
    document.getElementById('dropzoneResult').style.display = 'none';
    document.getElementById('newJobError').style.display = 'none';
    document.getElementById('newJobModal').classList.add('active');
  }

  function closeNewJobModal() { document.getElementById('newJobModal').classList.remove('active'); }

  async function createJob() {
    const name = document.getElementById('jobName').value.trim();
    const speed = parseInt(document.getElementById('jobSpeed').value) || 50;
    const errEl = document.getElementById('newJobError');
    const btn = document.getElementById('createJobBtn');
    errEl.style.display = 'none';
    if (!name) { errEl.textContent = 'Enter a job name'; errEl.style.display = 'block'; return; }
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Creating...';
    try {
      const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ name, speed }) });
      if (selectedFile) {
        const fd = new FormData(); fd.append('file', selectedFile);
        const up = await api('/api/jobs/' + job.id + '/upload', { method: 'POST', body: fd });
        toast(`Job created with ${up.skus_found||0} SKUs`, 'success');
      } else { toast('Job created', 'success'); }
      closeNewJobModal(); loadDashboard();
    } catch (err) { errEl.textContent = err.message; errEl.style.display = 'block'; }
    finally { btn.disabled = false; btn.textContent = 'Create Job'; }
  }

  // ---- Polling ----
  function startPolling() { stopPolling(); pollTimer = setInterval(() => { if (currentJobId) loadJobDetail(); }, 10000); }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  // ---- Helpers ----
  function esc(s) { if (s==null) return ''; const el=document.createElement('span'); el.textContent=String(s); return el.innerHTML; }
  function setText(id, t) { const el=document.getElementById(id); if(el) el.textContent=t; }
  function fmtNum(n) { return n!=null ? Number(n).toLocaleString() : '0'; }
  function fmtPrice(p) { return p!=null && p!=='' ? '$'+Number(p).toFixed(2) : '-'; }
  function fmtDate(d) { if(!d) return '-'; const dt=new Date(d+'Z'); return isNaN(dt)?d:dt.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric'}); }

  function statusBadge(s) {
    if(!s) s='pending';
    const cls = {running:'badge-running',paused:'badge-paused',done:'badge-done',stopped:'badge-done',error:'badge-error',pending:'badge-pending'}[s]||'badge-pending';
    return `<span class="badge ${cls}">${esc(s)}</span>`;
  }

  function yesNoBadge(v) {
    if (!v || v==='-') return '<span style="color:var(--text-muted)">-</span>';
    const lv = String(v).toLowerCase();
    if (lv==='yes'||lv.startsWith('да')) return `<span style="color:var(--success);font-weight:600">${esc(v)}</span>`;
    if (lv==='no'||lv.startsWith('нет')||lv==='не найден') return `<span style="color:var(--text-muted)">${esc(v)}</span>`;
    if (lv==='пограничный') return `<span style="color:var(--warning);font-weight:600">${esc(v)}</span>`;
    return `<span style="color:var(--text-secondary)">${esc(v)}</span>`;
  }

  function recBadgeHtml(rec, status, big) {
    const style = big ? 'font-size:1.2rem;padding:8px 24px' : '';
    if (rec === 'ЗАХОДИТЬ') return `<span class="badge badge-enter" style="${style}">ЗАХОДИТЬ</span>`;
    if (rec === 'НЕ ЗАХОДИТЬ') return `<span class="badge badge-no-enter" style="${style}">НЕ ЗАХОДИТЬ</span>`;
    if (rec) return `<span class="badge badge-maybe" style="${style}">${esc(rec)}</span>`;
    return `<span class="badge badge-${status||'pending'}" style="${style}">${esc(status||'pending')}</span>`;
  }

  function dRow(label, value) {
    const v = value!=null && value!=='' ? value : '-';
    return `<div class="detail-row"><span class="detail-label">${esc(label)}</span><span class="detail-value">${typeof v==='string'&&v.startsWith('<')?v:esc(String(v))}</span></div>`;
  }

  function toast(msg, type) {
    const c = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = 'toast toast-' + (type||'info');
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => { el.style.opacity='0'; el.style.transition='opacity .3s'; setTimeout(()=>el.remove(),300); }, 4000);
  }

  // ---- Init ----
  function init() {
    if (!getToken()) { goLogin(); return; }

    // Dropzone
    const dz = document.getElementById('dropzone'), fi = document.getElementById('fileInput');
    if (dz) {
      dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
      dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('dragover'); if(e.dataTransfer.files[0]) pickFile(e.dataTransfer.files[0]); });
      fi.addEventListener('change', () => { if(fi.files[0]) pickFile(fi.files[0]); });
    }
    function pickFile(f) {
      selectedFile = f;
      const r = document.getElementById('dropzoneResult');
      r.textContent = 'Selected: ' + f.name + ' (' + (f.size/1024).toFixed(1) + ' KB)';
      r.style.display = 'block';
    }

    document.getElementById('newJobModal').addEventListener('click', function(e) { if(e.target===this) closeNewJobModal(); });
    document.addEventListener('keydown', e => { if(e.key==='Escape') closeNewJobModal(); });

    window.addEventListener('hashchange', handleRoute);
    handleRoute();
  }

  document.addEventListener('DOMContentLoaded', init);

  return { navigate, logout: goLogin, openNewJobModal, closeNewJobModal, createJob, deleteJob, doJobAction, jobAction, exportJob, goPage, loadDashboard, loadJobDetail };
})();
