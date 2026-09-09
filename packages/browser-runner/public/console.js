const listView = document.querySelector('#list-view');
const detailView = document.querySelector('#detail-view');
const caseList = document.querySelector('#case-list');
const summary = document.querySelector('#summary');
const health = document.querySelector('#health');
const runRequestErrors = new Map();
const navChecks = document.querySelector('#nav-checks');
const navCases = document.querySelector('#nav-cases');
let cachedChecks = [];
let cachedCases = [];
let currentMode = 'checks';
let viewToken = 0;

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
  const token = ++viewToken;
  listView.classList.add('hidden'); detailView.classList.remove('hidden');
  try {
    const { testCase } = await api(`/api/test-cases/${encodeURIComponent(id)}`);
    if (token !== viewToken) return;
    const requestError = runRequestErrors.get(id);
    const gaps = testCase.draftIssues || []; const runnable = isRunnable(testCase); const run = testCase.runs?.at(-1); const snapshot = run?.caseSnapshot;
    const cleanupLabel = ({ failed: '清理失败', completed: '清理完成', not_required: '无需清理', not_started: '未开始' })[run?.cleanup?.status] || '旧版本未记录';
    const metadata = testCase.metadata || {}; const provenance = testCase.provenance || {}; const confirmation = testCase.humanConfirmation || { status: 'pending', questions: [] };
    detailView.innerHTML = `<button class="back" id="back" type="button">← 返回任务</button><header class="detail-hero"><div><h1>${escapeHtml(testCase.title)}</h1><p>${escapeHtml(testCase.project || '通用项目')} · ${escapeHtml(id)}</p></div><span class="pill ${runnable ? '' : 'draft'}">${runnable ? '可执行' : `草稿 · ${gaps.length} 项待补全`}</span></header><article class="workspace">
      <div class="workspace-head"><div><h2>测试资产</h2><p>当前版本 v${testCase.version || 1}${testCase.sourceRevision ? ` · 代码 ${escapeHtml(testCase.sourceRevision)}` : ''}</p></div><button id="run" class="primary" type="button" ${runnable ? '' : 'disabled'}>开始执行</button></div>
      ${metadata.kind ? `<section class="proposal-meta"><div><small>提案标识</small><p>${escapeHtml(metadata.proposalId || id)}</p></div><div><small>提案 / 证据包摘要</small><p>${escapeHtml(metadata.proposalDigest?.slice(0, 16))} / ${escapeHtml(metadata.packetDigest?.slice(0, 16))}</p></div><div><small>源事件</small><p>${provenance.sourceEventRefs?.length || 0} 个 · ${escapeHtml(metadata.proposalRef || '')}</p></div></section>` : ''}
      ${confirmation.questions?.length ? `<section class="quality"><strong>人工确认：${escapeHtml(confirmation.status)}</strong>${confirmation.questions.map((question) => `<p>○ ${escapeHtml(question)}</p>`).join('')}</section>` : ''}
      ${gaps.length ? `<section class="gaps"><strong>待补全项</strong><ul>${gaps.map((issue) => `<li><span>${escapeHtml(issue.code || 'UNRESOLVED_STEP')}</span>${escapeHtml(issue.message || '待补全')}${issue.stepId ? `<small>步骤 ${escapeHtml(issue.stepId)}</small>` : ''}</li>`).join('')}</ul></section>` : ''}
      ${requestError ? `<div id="run-request-error" class="error request-error">执行请求状态未确认：${escapeHtml(requestError)}</div>` : ''}
      <section class="run-summary"><div><small>执行状态</small><strong>${executionLabel(run)}</strong></div><div><small>业务结论</small><strong>${run?.businessVerdict === 'passed' ? '自动断言通过' : '业务未评估'}</strong></div><div class="${run?.cleanup?.status === 'failed' ? 'cleanup-failed' : ''}"><small>环境清理</small><strong>${cleanupLabel}</strong></div><div><small>步骤 / 断言</small><strong>${testCase.steps?.length || 0} / ${testCase.assertions?.length || 0}</strong></div></section>
      ${run ? `<section class="run-detail"><div class="run-head"><div><strong>最近一次执行</strong><small>${time(run.completedAt)}${Number.isFinite(run.elapsedMs) ? ` · ${run.elapsedMs} ms` : ''}</small></div><button id="snapshot-toggle" class="secondary" type="button" ${snapshot ? '' : 'disabled'}>查看执行快照</button></div>${run.errorCode ? `<div class="error">错误：${escapeHtml(run.errorCode)}</div>` : ''}<dl id="snapshot" class="snapshot hidden">${snapshot ? `<div><dt>执行时标题</dt><dd>${escapeHtml(snapshot.title)}</dd></div><div><dt>执行时版本</dt><dd>v${run.caseVersion || snapshot.version || 1}</dd></div><div><dt>代码版本</dt><dd>${escapeHtml(snapshot.sourceRevision || '未记录')}</dd></div><div><dt>环境</dt><dd>${escapeHtml(snapshot.environment?.baseUrl || '未绑定')}</dd></div><div><dt>步骤</dt><dd>${snapshot.steps?.length || 0}</dd></div><div><dt>自动断言</dt><dd>${snapshot.assertions?.length || 0}</dd></div><div><dt>清理步骤</dt><dd>${snapshot.cleanup?.steps?.length || 0}</dd></div><div><dt>快照摘要</dt><dd>${escapeHtml(run.caseSnapshotDigest?.slice(0, 12) || '未记录')}</dd></div>` : ''}</dl></section>` : '<div class="notice flat">尚无执行记录</div>'}</article>`;
    document.querySelector('#back').addEventListener('click', showList);
    document.querySelector('#run').addEventListener('click', () => runCase(id));
    document.querySelector('#snapshot-toggle')?.addEventListener('click', () => document.querySelector('#snapshot').classList.toggle('hidden'));
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
  const token = ++viewToken;
  listView.classList.add('hidden'); detailView.classList.remove('hidden'); detailView.innerHTML = '<div class="notice">正在读取回归检查…</div>';
  try {
    const { check } = await api(`/api/checks/${encodeURIComponent(id)}`); if (token !== viewToken) return; const run = check.latestRun; const active = ['pending', 'running'].includes(run?.executionStatus);
    detailView.innerHTML = `<button class="back" id="back" type="button">← 返回检查</button><header class="detail-hero"><div><h1>${escapeHtml(check.title)}</h1><p>${escapeHtml(check.project)} · ${escapeHtml(check.id)}</p></div><span class="pill ${statusClass(run)}">${executionLabel(run)}</span></header><article class="workspace">
      <div class="workspace-head"><div><h2>${escapeHtml(check.purpose)}</h2><p>基线 ${escapeHtml(check.baseline.version)} · 应用版本 ${escapeHtml(check.baseline.applicationRevision?.slice(0, 12))}</p></div><button id="run" class="primary" type="button" ${active ? 'disabled' : ''}>${active ? '执行中…' : '执行本项检查'}</button></div>
      <section class="explain"><div><small>检查方法</small><p>${escapeHtml(check.method)}</p></div><div><small>判定依据</small><p>${escapeHtml(check.basis)}</p></div></section>
      <section class="quality"><strong>待人工确认的质量标准</strong>${check.proposedQualityChecks.map((item) => `<p>○ ${escapeHtml(item.title)} <em>待确认</em></p>`).join('')}</section>
      <section class="run-summary"><div><small>执行状态</small><strong>${executionLabel(run)}</strong></div><div><small>客观检查结果</small><strong>${verdictLabel(run)}</strong></div><div><small>执行时间</small><strong>${time(run?.startedAt)}</strong></div><div><small>耗时</small><strong>${Number.isFinite(run?.elapsedMs) ? `${Math.round(run.elapsedMs / 100) / 10} 秒` : '未记录'}</strong></div></section>
      ${active ? `<section class="live"><strong>实时进度</strong><pre>${escapeHtml((run.logTail || []).join('\n') || '已进入执行队列…')}</pre></section>` : ''}
      <section class="run-detail"><div class="run-head"><div><strong>客观检查项</strong><small>只判定可观测事实；内容质量仍需人工确认</small></div></div><ul class="check-results">${checkResultRows(run)}</ul><details open><summary>执行证据与历史（${check.history.length}）</summary>${check.history.slice().reverse().map((item) => `<details class="history-entry"><summary>${time(item.startedAt)} · ${executionLabel(item)} · ${verdictLabel(item)}</summary><p>${escapeHtml(item.source || '本地控制台')} · ${escapeHtml(item.applicationRevision || '版本未记录')}</p><ul class="check-results">${checkResultRows(item)}</ul><div class="evidence-paths">${(item.evidenceRefs || []).map((ref) => `<code>${escapeHtml(ref)}</code>`).join('') || '<span>未记录证据路径</span>'}</div></details>`).join('')}</details></section></article>`;
    document.querySelector('#back').addEventListener('click', showList); document.querySelector('#run').addEventListener('click', () => runCheck(id)); if (active) setTimeout(() => { if (token === viewToken && !detailView.classList.contains('hidden')) void showCheck(id); }, 1200);
  } catch (error) { detailView.innerHTML = `<button class="back" id="back" type="button">← 返回检查</button><div class="error large">${escapeHtml(error.message)}</div>`; document.querySelector('#back').addEventListener('click', showList); }
}
async function runCheck(id) { try { await api(`/api/checks/${encodeURIComponent(id)}/runs`, { method: 'POST', body: '{}' }); await showCheck(id); } catch (error) { window.alert(error.message); await showCheck(id); } }
function renderCurrentMode() { currentMode === 'checks' ? renderChecks(cachedChecks) : renderCases(cachedCases); navChecks.classList.toggle('active', currentMode === 'checks'); navCases.classList.toggle('active', currentMode === 'cases'); }
async function refreshList(token, chooseFallback = false) { try { const [checkData, caseData, healthData] = await Promise.all([api('/api/checks'), api('/api/test-cases'), api('/api/health')]); if (token !== viewToken) return; health.textContent = healthData.ok ? '运行器已连接' : '运行器异常'; health.className = `health ${healthData.ok ? 'ok' : 'bad'}`; cachedChecks = checkData.checks || []; cachedCases = caseData.cases || []; if (chooseFallback && !cachedChecks.length) currentMode = 'cases'; renderCurrentMode(); } catch (error) { if (token !== viewToken) return; health.textContent = '控制平面未连接'; health.className = 'health bad'; caseList.innerHTML = `<div class="error large">${escapeHtml(error.message)}</div>`; } }
function showList() { const token = ++viewToken; detailView.classList.add('hidden'); listView.classList.remove('hidden'); renderCurrentMode(); void refreshList(token); }
async function load() { await refreshList(viewToken, true); }
navChecks.addEventListener('click', () => { currentMode = 'checks'; showList(); });
navCases.addEventListener('click', () => { currentMode = 'cases'; showList(); });
void load();
