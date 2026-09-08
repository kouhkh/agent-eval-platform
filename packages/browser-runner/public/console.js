const listView = document.querySelector('#list-view');
const detailView = document.querySelector('#detail-view');
const caseList = document.querySelector('#case-list');
const summary = document.querySelector('#summary');
const health = document.querySelector('#health');
let cases = [];
const runRequestErrors = new Map();

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

async function api(path, init) {
  const response = await fetch(path, { cache: 'no-store', ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.error || `请求失败（${response.status}）`);
    error.payload = body;
    error.httpStatus = response.status;
    throw error;
  }
  return body;
}

function isRunnable(testCase) {
  return testCase.assetState === 'runnable' && (testCase.draftIssues?.length || 0) === 0;
}

function assetLabel(testCase) {
  const gaps = testCase.draftIssues?.length || 0;
  return isRunnable(testCase) ? '可执行' : `草稿 · ${gaps} 项待补全`;
}

function executionLabel(run) {
  if (!run) return '尚未执行';
  return ({ completed: '执行完成', interrupted: '执行中断', not_started: '未开始' })[run.executionStatus] || '历史记录';
}

function verdictLabel(run) {
  if (!run) return '业务未评估';
  return ({ passed: '自动断言通过', not_evaluated: '业务未评估' })[run.businessVerdict] || '旧版本未记录';
}

function cleanupLabel(cleanup) {
  if (!cleanup) return '旧版本未记录';
  return ({ failed: '清理失败', completed: '清理完成', not_required: '无需清理', not_started: '未开始' })[cleanup.status] || cleanup.status || '旧版本未记录';
}

function renderList() {
  const runnable = cases.filter(isRunnable).length;
  const draft = cases.length - runnable;
  summary.innerHTML = `<div><small>资产总数</small><strong>${cases.length}</strong></div><div><small>可执行</small><strong>${runnable}</strong></div><div><small>待补全</small><strong>${draft}</strong></div>`;
  if (cases.length === 0) {
    caseList.innerHTML = '<div class="notice">暂无测试资产</div>';
    return;
  }
  caseList.innerHTML = cases.map((testCase) => `
    <button class="case-row" type="button" data-case-id="${escapeHtml(testCase.id)}">
      <span class="case-icon">◇</span>
      <span class="case-main"><small>${escapeHtml(testCase.id)}</small><strong>${escapeHtml(testCase.title)}</strong><em>${escapeHtml(testCase.project || '通用项目')}</em></span>
      <span class="case-stats"><span><b>${testCase.steps?.length || 0}</b> 执行步</span><span><b>v${testCase.version || 1}</b> 当前版本</span></span>
      <span class="pill ${isRunnable(testCase) ? '' : 'draft'}">${assetLabel(testCase)}</span><span class="arrow">›</span>
    </button>`).join('');
  caseList.querySelectorAll('[data-case-id]').forEach((button) => button.addEventListener('click', () => showDetail(button.dataset.caseId)));
}

function cleanupFailureText(cleanup) {
  const failures = cleanup?.errorDetails?.failures || cleanup?.sessionClose?.failures || [];
  const detail = failures.map((failure) => `${failure.phase || 'cleanup'}/${failure.code || 'UNKNOWN'}`).join(' · ');
  return `${cleanup?.errorCode || cleanup?.errorDetails?.code || 'TEST_CLEANUP_FAILED'}${detail ? ` · ${detail}` : ''}`;
}

async function showDetail(id) {
  detailView.innerHTML = '<div class="notice">正在读取任务…</div>';
  listView.classList.add('hidden');
  detailView.classList.remove('hidden');
  try {
    const { testCase } = await api(`/api/test-cases/${encodeURIComponent(id)}`);
    const gaps = testCase.draftIssues || [];
    const runnable = isRunnable(testCase);
    const run = testCase.runs?.at(-1);
    const snapshot = run?.caseSnapshot;
    const requestError = runRequestErrors.get(testCase.id);
    detailView.innerHTML = `
      <button class="back" id="back" type="button">← 返回任务</button>
      <header class="detail-hero"><div><h1>${escapeHtml(testCase.title)}</h1><p>${escapeHtml(testCase.project || '通用项目')} · ${escapeHtml(testCase.id)}</p></div><span class="pill ${runnable ? '' : 'draft'}">${assetLabel(testCase)}</span></header>
      <article class="workspace">
        <div class="workspace-head"><div><h2>测试资产</h2><p>当前版本 v${testCase.version || 1}${testCase.sourceRevision ? ` · 代码 ${escapeHtml(testCase.sourceRevision)}` : ''}</p></div><button id="run" class="primary" type="button" ${runnable ? '' : 'disabled'}>开始执行</button></div>
        ${gaps.length ? `<section class="gaps"><strong>待补全项</strong><ul>${gaps.map((issue) => `<li><span>${escapeHtml(issue.code || 'UNRESOLVED_STEP')}</span>${escapeHtml(issue.message || '待补全')}${issue.stepId ? `<small>步骤 ${escapeHtml(issue.stepId)}</small>` : ''}</li>`).join('')}</ul></section>` : ''}
        ${requestError ? `<div id="run-request-error" class="error request-error">执行请求状态未确认：${escapeHtml(requestError)}</div>` : ''}
        <section class="run-summary">
          <div><small>执行状态</small><strong>${executionLabel(run)}</strong></div>
          <div><small>业务结论</small><strong>${verdictLabel(run)}</strong></div>
          <div class="${run?.cleanup?.status === 'failed' ? 'cleanup-failed' : ''}"><small>环境清理</small><strong>${cleanupLabel(run?.cleanup)}</strong></div>
          <div><small>用例版本</small><strong>${run?.caseVersion ? `v${run.caseVersion}` : '尚无快照'}</strong></div>
        </section>
        ${run ? `<section class="run-detail"><div class="run-head"><div><strong>最近一次执行</strong><small>${run.completedAt ? new Date(run.completedAt).toLocaleString('zh-CN') : '时间未记录'}${Number.isFinite(run.elapsedMs) ? ` · ${run.elapsedMs} ms` : ''}</small></div><button id="snapshot-toggle" class="secondary" type="button" ${snapshot ? '' : 'disabled'}>查看执行快照</button></div>${run.errorCode ? `<div class="error">错误：${escapeHtml(run.errorCode)}</div>` : ''}${run.cleanup?.status === 'failed' ? `<div class="error">清理失败：${escapeHtml(cleanupFailureText(run.cleanup))}</div>` : ''}<dl id="snapshot" class="snapshot hidden">${snapshot ? `<div><dt>执行时标题</dt><dd>${escapeHtml(snapshot.title)}</dd></div><div><dt>执行时版本</dt><dd>v${run.caseVersion || snapshot.version || 1}</dd></div><div><dt>代码版本</dt><dd>${escapeHtml(snapshot.sourceRevision || '未记录')}</dd></div><div><dt>环境</dt><dd>${escapeHtml(snapshot.environment?.baseUrl || '未绑定')}</dd></div><div><dt>步骤</dt><dd>${snapshot.steps?.length || 0}</dd></div><div><dt>自动断言</dt><dd>${snapshot.assertions?.length || 0}</dd></div><div><dt>清理步骤</dt><dd>${snapshot.cleanup?.steps?.length || 0}</dd></div><div><dt>快照摘要</dt><dd>${escapeHtml(run.caseSnapshotDigest?.slice(0, 12) || '未记录')}</dd></div>` : ''}</dl></section>` : '<div class="notice flat">尚无执行记录</div>'}
      </article>`;
    document.querySelector('#back').addEventListener('click', showList);
    document.querySelector('#run').addEventListener('click', () => runCase(testCase.id));
    document.querySelector('#snapshot-toggle')?.addEventListener('click', (event) => {
      const panel = document.querySelector('#snapshot');
      panel.classList.toggle('hidden');
      event.currentTarget.textContent = panel.classList.contains('hidden') ? '查看执行快照' : '收起执行快照';
    });
  } catch (error) {
    detailView.innerHTML = `<button class="back" id="back" type="button">← 返回任务</button><div class="error large">任务读取失败：${escapeHtml(error.message)}</div>`;
    document.querySelector('#back').addEventListener('click', showList);
  }
}

async function runCase(id) {
  const button = document.querySelector('#run');
  button.disabled = true;
  button.textContent = '正在执行…';
  try {
    await api(`/api/test-cases/${encodeURIComponent(id)}/runs`, { method: 'POST', body: '{}' });
    runRequestErrors.delete(id);
  } catch (error) {
    if (error.payload?.testCaseId) runRequestErrors.delete(id);
    else runRequestErrors.set(id, error.message);
  } finally {
    await loadCases();
    await showDetail(id);
  }
}

function showList() {
  detailView.classList.add('hidden');
  listView.classList.remove('hidden');
  renderList();
}

async function loadCases() {
  try {
    const [caseResult, healthResult] = await Promise.all([api('/api/test-cases'), api('/api/health')]);
    cases = caseResult.cases || [];
    health.textContent = healthResult.ok ? '运行器已连接' : '运行器异常';
    health.className = `health ${healthResult.ok ? 'ok' : 'bad'}`;
    renderList();
  } catch (error) {
    health.textContent = '控制平面未连接';
    health.className = 'health bad';
    caseList.innerHTML = `<div class="error large">${escapeHtml(error.message)}</div>`;
  }
}

void loadCases();
