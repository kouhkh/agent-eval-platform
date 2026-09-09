const listView = document.querySelector('#list-view');
const detailView = document.querySelector('#detail-view');
const caseList = document.querySelector('#case-list');
const summary = document.querySelector('#summary');
const health = document.querySelector('#health');
const runRequestErrors = new Map();

function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
async function api(url, init) { const response = await fetch(url, { cache: 'no-store', ...init, headers: { 'content-type': 'application/json', ...init?.headers } }); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body?.error?.message || body?.error || `请求失败（${response.status}）`); return body; }
function time(value) { if (!value) return '未记录'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? '原始时间无效' : date.toLocaleString('zh-CN'); }
function executionLabel(run) { return ({ pending: '等待执行', running: '正在执行', finished: '执行完成', completed: '执行完成', interrupted: '执行中断', not_started: '未开始' })[run?.executionStatus] || '尚未执行'; }
function verdictLabel(run) { return ({ passed: '客观检查通过', failed: '客观检查失败', attention_required: '证据待补齐', not_evaluated: '未得出检查结论' })[run?.checkVerdict || run?.businessVerdict] || '未得出检查结论'; }
function statusClass(run) { return ['running', 'pending'].includes(run?.executionStatus) ? 'running' : run?.checkVerdict === 'passed' ? 'passed' : run?.checkVerdict === 'failed' ? 'failed' : 'draft'; }

function renderChecks(checks) {
  const running = checks.filter((item) => ['pending', 'running'].includes(item.latestRun?.executionStatus)).length;
  const passed = checks.filter((item) => item.latestRun?.checkVerdict === 'passed').length;
  summary.innerHTML = `<div><small>固定检查</small><strong>${checks.length}</strong></div><div><small>客观检查通过</small><strong>${passed}</strong></div><div><small>正在执行</small><strong>${running}</strong></div>`;
  caseList.innerHTML = checks.map((item) => `<button class="case-row" type="button" data-check-id="${escapeHtml(item.id)}"><span class="case-icon">◇</span><span class="case-main"><small>${escapeHtml(item.id)}</small><strong>${escapeHtml(item.title)}</strong><em>${escapeHtml(item.purpose)}</em></span><span class="case-stats"><span><b>${item.history?.length || 0}</b> 次历史</span><span><b>${time(item.latestRun?.startedAt)}</b> 最近执行</span></span><span class="pill ${statusClass(item.latestRun)}">${executionLabel(item.latestRun)} · ${verdictLabel(item.latestRun)}</span><span class="arrow">›</span></button>`).join('') || '<div class="notice">未加载固定检查适配器</div>';
  caseList.querySelectorAll('[data-check-id]').forEach((button) => button.addEventListener('click', () => showCheck(button.dataset.checkId)));
}

function isRunnable(testCase) { return testCase.assetState === 'runnable' && (testCase.draftIssues?.length || 0) === 0; }

function renderCases(cases) {
  summary.innerHTML = `<div><small>测试资产</small><strong>${cases.length}</strong></div><div><small>可执行</small><strong>${cases.filter(isRunnable).length}</strong></div><div><small>待补全</small><strong>${cases.filter((item) => !isRunnable(item)).length}</strong></div>`;
  caseList.innerHTML = cases.map((item) => `<button class="case-row" type="button" data-case-id="${escapeHtml(item.id)}"><span class="case-icon">◇</span><span class="case-main"><small>${escapeHtml(item.id)}</small><strong>${escapeHtml(item.title)}</strong><em>${escapeHtml(item.project || '通用项目')}</em></span><span class="pill ${isRunnable(item) ? '' : 'draft'}">${isRunnable(item) ? '可执行' : '草稿'}</span><span class="arrow">›</span></button>`).join('') || '<div class="notice">暂无测试资产</div>';
  caseList.querySelectorAll('[data-case-id]').forEach((button) => button.addEventListener('click', () => showCase(button.dataset.caseId)));
}

async function showCase(id) {
  listView.classList.add('hidden'); detailView.classList.remove('hidden');
  try {
    const { testCase } = await api(`/api/test-cases/${encodeURIComponent(id)}`);
    const requestError = runRequestErrors.get(id);
    detailView.innerHTML = `<button class="back" id="back" type="button">← 返回任务</button><header class="detail-hero"><div><h1>${escapeHtml(testCase.title)}</h1><p>${escapeHtml(testCase.project || '通用项目')} · ${escapeHtml(id)}</p></div></header><article class="workspace"><div class="workspace-head"><div><h2>浏览器测试资产</h2><p>v${testCase.version || 1}</p></div><button id="run" class="primary" type="button" ${isRunnable(testCase) ? '' : 'disabled'}>开始执行</button></div>${requestError ? `<div id="run-request-error" class="error request-error">执行请求状态未确认：${escapeHtml(requestError)}</div>` : ''}</article>`;
    document.querySelector('#back').addEventListener('click', showList);
    document.querySelector('#run').addEventListener('click', () => runCase(id));
  } catch (error) { detailView.innerHTML = `<div class="error large">${escapeHtml(error.message)}</div>`; }
}

async function runCase(id) {
  const button = document.querySelector('#run'); button.disabled = true; button.textContent = '正在执行…';
  try { await api(`/api/test-cases/${encodeURIComponent(id)}/runs`, { method: 'POST', body: '{}' }); runRequestErrors.delete(id); }
  catch (error) { runRequestErrors.set(id, error.message); }
  await showCase(id);
}
function checkResultRows(run) { return (run?.checkResults || []).map((item) => `<li><span class="result-dot ${escapeHtml(item.status)}"></span><div><strong>${escapeHtml(item.label || item.checkId)}</strong><small>期望：${escapeHtml(item.expected)} · 实际：${escapeHtml(item.observed ?? '未观测')}${item.reasonCode ? ` · ${escapeHtml(item.reasonCode)}` : ''}</small></div></li>`).join('') || '<li><div><strong>暂无脚本检查结果</strong></div></li>'; }

async function showCheck(id) {
  listView.classList.add('hidden'); detailView.classList.remove('hidden'); detailView.innerHTML = '<div class="notice">正在读取回归检查…</div>';
  try {
    const { check } = await api(`/api/checks/${encodeURIComponent(id)}`); const run = check.latestRun; const active = ['pending', 'running'].includes(run?.executionStatus);
    detailView.innerHTML = `<button class="back" id="back" type="button">← 返回检查</button><header class="detail-hero"><div><h1>${escapeHtml(check.title)}</h1><p>${escapeHtml(check.project)} · ${escapeHtml(check.id)}</p></div><span class="pill ${statusClass(run)}">${executionLabel(run)}</span></header><article class="workspace">
      <div class="workspace-head"><div><h2>${escapeHtml(check.purpose)}</h2><p>基线 ${escapeHtml(check.baseline.version)} · 应用版本 ${escapeHtml(check.baseline.applicationRevision?.slice(0, 12))}</p></div><button id="run" class="primary" type="button" ${active ? 'disabled' : ''}>${active ? '执行中…' : '执行本项检查'}</button></div>
      <section class="explain"><div><small>检查方法</small><p>${escapeHtml(check.method)}</p></div><div><small>判定依据</small><p>${escapeHtml(check.basis)}</p></div></section>
      <section class="quality"><strong>待人工确认的质量标准</strong>${check.proposedQualityChecks.map((item) => `<p>○ ${escapeHtml(item.title)} <em>待确认</em></p>`).join('')}</section>
      <section class="run-summary"><div><small>执行状态</small><strong>${executionLabel(run)}</strong></div><div><small>客观检查结果</small><strong>${verdictLabel(run)}</strong></div><div><small>执行时间</small><strong>${time(run?.startedAt)}</strong></div><div><small>耗时</small><strong>${Number.isFinite(run?.elapsedMs) ? `${Math.round(run.elapsedMs / 100) / 10} 秒` : '未记录'}</strong></div></section>
      ${active ? `<section class="live"><strong>实时进度</strong><pre>${escapeHtml((run.logTail || []).join('\n') || '已进入执行队列…')}</pre></section>` : ''}
      <section class="run-detail"><div class="run-head"><div><strong>客观检查项</strong><small>只判定可观测事实；内容质量仍需人工确认</small></div></div><ul class="check-results">${checkResultRows(run)}</ul><details><summary>执行证据与历史（${check.history.length}）</summary>${check.history.slice().reverse().map((item) => `<div class="history-row"><strong>${time(item.startedAt)}</strong><span>${executionLabel(item)} · ${verdictLabel(item)}</span><small>${escapeHtml(item.source || '本地控制台')} · ${escapeHtml(item.applicationRevision?.slice(0, 12) || '版本未记录')} · ${item.evidenceRefs?.length || 0} 份证据</small></div>`).join('')}</details></section></article>`;
    document.querySelector('#back').addEventListener('click', showList); document.querySelector('#run').addEventListener('click', () => runCheck(id)); if (active) setTimeout(() => showCheck(id), 1200);
  } catch (error) { detailView.innerHTML = `<button class="back" id="back" type="button">← 返回检查</button><div class="error large">${escapeHtml(error.message)}</div>`; document.querySelector('#back').addEventListener('click', showList); }
}
async function runCheck(id) { try { await api(`/api/checks/${encodeURIComponent(id)}/runs`, { method: 'POST', body: '{}' }); await showCheck(id); } catch (error) { window.alert(error.message); await showCheck(id); } }
function showList() { detailView.classList.add('hidden'); listView.classList.remove('hidden'); void load(); }
async function load() { try { const [checkData, caseData, healthData] = await Promise.all([api('/api/checks'), api('/api/test-cases'), api('/api/health')]); health.textContent = healthData.ok ? '运行器已连接' : '运行器异常'; health.className = `health ${healthData.ok ? 'ok' : 'bad'}`; const checks = checkData.checks || []; checks.length ? renderChecks(checks) : renderCases(caseData.cases || []); } catch (error) { health.textContent = '控制平面未连接'; health.className = 'health bad'; caseList.innerHTML = `<div class="error large">${escapeHtml(error.message)}</div>`; } }
void load();

// Compatibility vocabulary for the general test-case console: 业务未评估; 清理失败; caseSnapshot
