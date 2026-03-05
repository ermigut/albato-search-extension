/**
 * Albato Apps Search — content script
 *
 * API: GET https://new.albato.ru/api/builder/apps?page=N&per_page=20
 * Response: { success, data: [...], meta: { page, totalPages, totalItemsCount } }
 * App shape: { id, info: { titleRu, titleEn, data: { logoUrl } } }
 *
 * Versions API: GET /api/builder/apps/{id}/versions
 * Version shape: { id, minorId, name, status, dateCreated }
 * status: 1=Published, 0=Draft
 */
(function () {
  'use strict';

  // .ru → /api/builder/apps
  // .com → /app/api/builder/apps
  const API_PREFIX = location.hostname.endsWith('.com') ? '/app' : '';
  const API_BASE = `${location.origin}${API_PREFIX}/api/builder/apps`;
  const PER_PAGE = 20;

  // ── 1. Inject page-context interceptor to capture auth headers ─────────────
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);

  // ── 2. State ───────────────────────────────────────────────────────────────
  let extraHeaders = {};
  let allApps = [];
  let searchReady = false;
  let expandedAppId = null;          // currently expanded app in results
  const versionsCache = {};          // appId → version[]

  // ── 3. Listen for captured auth headers ───────────────────────────────────
  window.addEventListener('__albato_auth__', (e) => {
    const h = e.detail.headers || {};
    const authKeys = ['authorization', 'x-auth-token', 'x-api-key', 'x-csrf-token', 'x-xsrf-token'];
    for (const [k, v] of Object.entries(h)) {
      if (authKeys.includes(k.toLowerCase())) extraHeaders[k] = v;
    }
  });

  // ── 4. Start loading once DOM is ready ────────────────────────────────────
  function isActivePage() {
    // .ru: /apps, /builder/constructor/...
    // .com: /app/apps, /app/builder/constructor/...
    return /^\/(app\/)?(apps|builder\/constructor)/.test(location.pathname);
  }

  function onNavigate() {
    if (isActivePage()) {
      if (!searchReady) init();
    } else {
      // Left active area — reset so we reinit when navigating back
      searchReady = false;
    }
  }

  window.addEventListener('popstate', onNavigate);
  window.addEventListener('__albato_nav__', onNavigate);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { if (isActivePage()) init(); });
  } else {
    if (isActivePage()) init();
  }

  async function init() {
    await sleep(1500);

    // Начинаем грузить аппы сразу, не ждём
    const appsPromise = fetchAllApps();

    // Как только сайдбар появится — инжектим UI в состоянии загрузки
    let finalize;
    try {
      const sidebar = await waitForSidebar();
      searchReady = true;
      finalize = injectSearchUI(sidebar);
    } catch (err) {
      console.warn('[Albato Search] Could not find sidebar:', err.message);
      await appsPromise;
      return;
    }

    // Ждём окончания загрузки аппов — активируем поиск
    await appsPromise;
    finalize();
  }

  // ── 5. Fetch all app pages ────────────────────────────────────────────────
  async function fetchAllApps() {
    try {
      const first = await apiFetch(API_BASE, { page: 1, per_page: PER_PAGE });
      if (!first?.success) { console.warn('[Albato Search] Non-success response', first); return; }
      allApps = first.data || [];

      const totalPages = first.meta?.totalPages ?? 1;
      if (totalPages > 1) {
        const pages = [];
        for (let p = 2; p <= totalPages; p++) pages.push(apiFetch(API_BASE, { page: p, per_page: PER_PAGE }));
        const results = await Promise.allSettled(pages);
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value?.data) allApps.push(...r.value.data);
        }
      }
      console.log(`[Albato Search] Loaded ${allApps.length} / ${first.meta?.totalItemsCount} apps`);
    } catch (err) {
      console.error('[Albato Search] Failed to load apps:', err);
    }
  }

  async function fetchVersions(appId) {
    if (versionsCache[appId]) return versionsCache[appId];

    const first = await apiFetch(`${API_BASE}/${appId}/versions`, { page: 1, per_page: PER_PAGE });
    let versions = first?.data || [];

    const totalPages = first?.meta?.totalPages ?? 1;
    if (totalPages > 1) {
      const pages = [];
      for (let p = 2; p <= totalPages; p++) pages.push(apiFetch(`${API_BASE}/${appId}/versions`, { page: p, per_page: PER_PAGE }));
      const results = await Promise.allSettled(pages);
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value?.data) versions.push(...r.value.data);
      }
    }

    versionsCache[appId] = versions;
    return versions;
  }

  async function apiFetch(url, params) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const resp = await fetch(u.toString(), {
      credentials: 'include',
      headers: { Accept: 'application/json', ...extraHeaders },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  // ── 6. Inject search UI ───────────────────────────────────────────────────
  // Принимает sidebar сразу (ожидание вынесено в init).
  // Возвращает finalize() — вызвать после загрузки всех аппов.
  function injectSearchUI(sidebar) {
    const wrapper = document.createElement('div');
    wrapper.id = 'abs-wrapper';
    wrapper.style.cssText = `
      padding: 8px 10px 6px;
      position: sticky; top: 0; z-index: 200;
      background: inherit;
      border-bottom: 1px solid rgba(0,0,0,0.07);
    `;

    const inputWrap = document.createElement('div');
    inputWrap.style.cssText = 'position:relative;';

    const input = document.createElement('input');
    input.id = 'abs-input';
    input.type = 'search';
    // Начальное состояние — идёт загрузка
    input.placeholder = 'Загрузка приложений…';
    input.disabled = true;
    input.style.cssText = `
      width: 100%; box-sizing: border-box;
      padding: 6px 28px 6px 10px;
      border: 1px solid #d0d5dd; border-radius: 6px;
      font-size: 12px; outline: none;
      background: #f9fafb; color: #344054;
      cursor: not-allowed; opacity: 0.65;
      transition: border-color .15s, background .25s, opacity .25s;
    `;
    input.addEventListener('focus', () => { input.style.borderColor = '#f5601d'; });
    input.addEventListener('blur',  () => { input.style.borderColor = '#d0d5dd'; });

    const clearBtn = document.createElement('button');
    clearBtn.textContent = '×';
    clearBtn.style.cssText = `
      position:absolute; right:6px; top:50%; transform:translateY(-50%);
      background:none; border:none; font-size:16px; color:#aaa;
      cursor:pointer; display:none; padding:0; line-height:1;
    `;
    clearBtn.addEventListener('click', () => {
      input.value = '';
      clearBtn.style.display = 'none';
      expandedAppId = null;
      showResults(null);
      input.focus();
    });

    inputWrap.appendChild(input);
    inputWrap.appendChild(clearBtn);
    wrapper.appendChild(inputWrap);

    const results = document.createElement('div');
    results.id = 'abs-results';
    results.style.cssText = `
      display: none;
      overflow-y: auto;
      max-height: calc(100vh - 80px);
      padding: 4px 0 8px;
    `;

    const origChildren = Array.from(sidebar.children);

    sidebar.insertBefore(wrapper, sidebar.firstChild);
    sidebar.insertBefore(results, wrapper.nextSibling);

    input.addEventListener('input', () => {
      const q = input.value;
      clearBtn.style.display = q ? 'block' : 'none';
      expandedAppId = null;
      showResults(q || null, results, origChildren);
    });

    input.addEventListener('search', () => {
      if (!input.value) {
        clearBtn.style.display = 'none';
        expandedAppId = null;
        showResults(null, results, origChildren);
      }
    });

    console.log('[Albato Search] Search UI injected (loading apps…)');

    // ── Вызывается после загрузки всех аппов ─────────────────────────────
    return function finalize() {
      input.disabled = false;
      input.style.cursor = '';
      input.style.opacity = '1';
      input.style.background = '#fff';
      input.placeholder = `Поиск (${allApps.length} apps)...`;

      // Восстановить состояние после hard-reload
      const saved = popState();
      if (saved?.query) {
        input.value = saved.query;
        clearBtn.style.display = 'block';
        showResults(saved.query, results, origChildren);

        if (saved.expandedAppId) {
          setTimeout(() => {
            const wrap = results.querySelector(`[data-app-id="${saved.expandedAppId}"]`);
            wrap?.querySelector('.abs-app-row')?.click();
          }, 50);
        }
      }

      console.log(`[Albato Search] Ready — ${allApps.length} apps loaded.`);
    };
  }

  // ── 7. Render app list ────────────────────────────────────────────────────
  function showResults(query, resultsEl, origChildren) {
    resultsEl = resultsEl || document.getElementById('abs-results');
    if (!resultsEl) return;

    const sidebar = resultsEl.parentElement;
    const orig = origChildren?.length
      ? origChildren
      : Array.from(sidebar.children).filter((el) => el.id !== 'abs-wrapper' && el.id !== 'abs-results');

    if (!query) {
      // Restore sidebar scrolling so frontend pagination works normally again
      if (sidebar.__absOrigOverflow__ !== undefined) {
        sidebar.style.overflowY = sidebar.__absOrigOverflow__;
        delete sidebar.__absOrigOverflow__;
      }
      resultsEl.style.display = 'none';
      resultsEl.innerHTML = '';
      orig.forEach((el) => { el.style.display = ''; });
      return;
    }

    // Freeze sidebar scroll → frontend's infinite-scroll won't fire
    if (sidebar.__absOrigOverflow__ === undefined) {
      sidebar.__absOrigOverflow__ = sidebar.style.overflowY;
    }
    sidebar.style.overflowY = 'hidden';

    orig.forEach((el) => { el.style.display = 'none'; });
    resultsEl.style.display = 'block';

    const q = query.toLowerCase();
    const matched = allApps.filter((app) => {
      const ru = (app.info?.titleRu || '').toLowerCase();
      const en = (app.info?.titleEn || '').toLowerCase();
      return ru.includes(q) || en.includes(q);
    });

    if (!matched.length) {
      resultsEl.innerHTML = `
        <div style="padding:16px 12px;text-align:center;color:#888;font-size:12px;">
          Ничего не найдено для «<b>${esc(query)}</b>»
        </div>`;
      return;
    }

    resultsEl.innerHTML = '';
    matched.forEach((app) => {
      resultsEl.appendChild(buildAppRow(app, q));
    });
  }

  // ── 8. Build app row element ──────────────────────────────────────────────
  function buildAppRow(app, query) {
    const name  = appName(app);
    const logo  = app.info?.data?.logoUrl ?? '';
    const isExp = String(app.id) === String(expandedAppId);

    const wrap = document.createElement('div');
    wrap.dataset.appId = app.id;

    // ── App header row ──────────────────────────────────────────────────────
    const row = document.createElement('div');
    row.className = 'abs-app-row';
    row.style.cssText = `
      display:flex; align-items:center; gap:8px;
      padding:7px 10px 7px 12px;
      cursor:pointer; border-radius:6px; margin:1px 6px;
      transition:background .1s;
      ${isExp ? 'background:rgba(245,96,29,0.07);' : ''}
    `;
    row.onmouseenter = () => { row.style.background = 'rgba(245,96,29,0.09)'; };
    row.onmouseleave = () => { row.style.background = isExp ? 'rgba(245,96,29,0.07)' : ''; };

    const imgHtml = logo
      ? `<img src="${esc(logo)}" width="22" height="22"
              style="border-radius:4px;object-fit:contain;flex-shrink:0;"
              onerror="this.style.display='none'">`
      : `<div style="width:22px;height:22px;border-radius:4px;background:#f0f0f0;flex-shrink:0;"></div>`;

    row.innerHTML = `
      ${imgHtml}
      <span style="flex:1;font-size:12px;font-weight:600;color:#344054;
                   white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
        ${highlight(esc(name), esc(query || ''))}
      </span>
      <span class="abs-chevron" style="font-size:10px;color:#aaa;flex-shrink:0;
                                       transition:transform .2s;
                                       ${isExp ? 'transform:rotate(180deg)' : ''}">▼</span>
    `;

    // ── Versions panel ──────────────────────────────────────────────────────
    const panel = document.createElement('div');
    panel.className = 'abs-versions-panel';
    panel.style.cssText = `
      overflow:hidden;
      max-height: ${isExp ? '2000px' : '0'};
      transition: max-height .25s ease;
    `;

    if (isExp && versionsCache[app.id]) {
      renderVersionsInPanel(panel, app, versionsCache[app.id]);
    }

    // ── Toggle click ────────────────────────────────────────────────────────
    row.addEventListener('click', async () => {
      const alreadyOpen = String(expandedAppId) === String(app.id);

      // Collapse current
      if (expandedAppId) {
        const prev = document.querySelector(`[data-app-id="${expandedAppId}"]`);
        if (prev) collapseAppRow(prev);
      }

      if (alreadyOpen) {
        expandedAppId = null;
        return;
      }

      expandedAppId = app.id;
      const chevron = row.querySelector('.abs-chevron');
      if (chevron) chevron.style.transform = 'rotate(180deg)';
      row.style.background = 'rgba(245,96,29,0.07)';

      // Show loader if not cached
      if (!versionsCache[app.id]) {
        panel.style.maxHeight = '2000px';
        panel.innerHTML = `
          <div style="padding:10px 12px 10px 42px;font-size:11px;color:#aaa;">
            Загрузка версий…
          </div>`;
      }

      try {
        const versions = await fetchVersions(app.id);
        if (String(expandedAppId) === String(app.id)) {
          panel.style.maxHeight = '2000px';
          renderVersionsInPanel(panel, app, versions);
        }
      } catch (err) {
        panel.innerHTML = `
          <div style="padding:10px 12px 10px 42px;font-size:11px;color:#e53e3e;">
            Ошибка загрузки версий
          </div>`;
      }
    });

    wrap.appendChild(row);
    wrap.appendChild(panel);
    return wrap;
  }

  function collapseAppRow(wrapEl) {
    const panel   = wrapEl.querySelector('.abs-versions-panel');
    const chevron = wrapEl.querySelector('.abs-chevron');
    const row     = wrapEl.querySelector('.abs-app-row');
    if (panel)   panel.style.maxHeight = '0';
    if (chevron) chevron.style.transform = '';
    if (row)     row.style.background = '';
  }

  // ── 9. Render versions inside panel ───────────────────────────────────────
  function renderVersionsInPanel(panel, app, versions) {
    panel.innerHTML = '';

    // Reverse chronological, show last 20
    const sorted = [...versions].reverse().slice(0, 20);

    // Latest version = first in sorted (newest). Button enabled only if status 2 or 3.
    const latestStatus = sorted[0]?.status ?? -1;
    const canAddVersion = versions.length === 0 || latestStatus === 2 || latestStatus === 3;

    // ── "Add a version" button — always at the TOP ────────────────────────
    const btnWrap = document.createElement('div');
    btnWrap.style.cssText = 'padding:6px 12px 6px 42px;';
    const btn = document.createElement('button');
    btn.textContent = '+ Add a version';

    if (canAddVersion) {
      btn.style.cssText = `
        font-size:11px;color:#f5601d;cursor:pointer;
        border:1px solid #f5601d;border-radius:4px;
        padding:3px 10px;background:none;transition:background .15s;`;
      btn.onmouseenter = () => { btn.style.background = 'rgba(245,96,29,0.07)'; };
      btn.onmouseleave = () => { btn.style.background = ''; };
      btn.addEventListener('click', (e) => { e.stopPropagation(); showAddVersionModal(app, panel); });
    } else {
      btn.disabled = true;
      const reason = latestStatus === 0 ? 'Private' : latestStatus === 1 ? 'Moderation' : 'current status';
      btn.title = `Cannot add version: latest version is ${reason}`;
      btn.style.cssText = `
        font-size:11px;color:#aaa;cursor:not-allowed;
        border:1px solid #e4e7ec;border-radius:4px;
        padding:3px 10px;background:none;`;
    }

    btnWrap.appendChild(btn);
    panel.appendChild(btnWrap);

    // ── Versions list ─────────────────────────────────────────────────────
    if (!sorted.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:4px 12px 8px 42px;font-size:11px;color:#aaa;';
      empty.textContent = 'Нет версий';
      panel.appendChild(empty);
      return;
    }

    const rows = sorted.map((v) => {
      const statusLabel = versionStatus(v.status);
      const date = formatDate(v.dateCreated);
      const canDelete = v.status === 0;
      return `
        <div class="abs-version-row" data-version-id="${v.id}" data-version-name="${esc(v.name || '')}"
          style="padding:6px 12px 6px 42px;cursor:pointer;
                 border-radius:4px;margin:1px 6px 1px 0;
                 transition:background .1s;position:relative;"
          onmouseenter="this.style.background='rgba(0,0,0,0.04)'"
          onmouseleave="this.style.background=''"
        >
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:12px;color:#344054;flex:1;
                         white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
              ${esc(v.name || '—')}
            </span>
            <span style="font-size:10px;padding:1px 6px;border-radius:10px;
                         flex-shrink:0;${statusLabel.style}">
              ${statusLabel.text}
            </span>
            ${canDelete ? `
            <button class="abs-del-btn"
              style="background:#fef2f2;border:1px solid #fecaca;cursor:pointer;
                     padding:2px 6px;color:#f87171;font-size:12px;line-height:1;
                     border-radius:4px;flex-shrink:0;transition:background .15s,color .15s;"
              onmouseenter="this.style.background='#fee2e2';this.style.color='#dc2626';this.style.borderColor='#fca5a5'"
              onmouseleave="this.style.background='#fef2f2';this.style.color='#f87171';this.style.borderColor='#fecaca'"
              title="Delete version">🗑 Delete</button>` : ''}
          </div>
          <div style="font-size:10px;color:#aaa;margin-top:1px;">ID: ${v.id}${date ? ` · ${date}` : ''}</div>
        </div>`;
    }).join('');

    const hiddenCount = versions.length - sorted.length;
    const moreHint = hiddenCount > 0
      ? `<div style="padding:4px 12px 4px 42px;font-size:10px;color:#aaa;">+${hiddenCount} более ранних версий</div>`
      : '';

    const listWrap = document.createElement('div');
    listWrap.innerHTML = `
      <div style="border-left:2px solid rgba(245,96,29,0.2);margin:0 6px 0 18px;">${rows}</div>
      ${moreHint}`;
    panel.appendChild(listWrap);

    listWrap.querySelectorAll('.abs-version-row').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        navigateToVersion(app.id, el.dataset.versionId);
      });
      const delBtn = el.querySelector('.abs-del-btn');
      if (delBtn) {
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          showDeleteVersionModal(app, { id: el.dataset.versionId, name: el.dataset.versionName }, panel);
        });
      }
    });
  }

  // ── Add version modal ─────────────────────────────────────────────────────
  function showAddVersionModal(app, panel) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,0.4);
      display:flex;align-items:center;justify-content:center;
      z-index:99999;
    `;

    const modal = document.createElement('div');
    modal.style.cssText = `
      background:#fff;border-radius:12px;padding:32px;
      width:480px;max-width:90vw;position:relative;
      box-shadow:0 20px 60px rgba(0,0,0,0.15);
    `;
    modal.innerHTML = `
      <button class="abs-mc" style="position:absolute;top:16px;right:16px;
        background:none;border:none;font-size:22px;color:#aaa;cursor:pointer;line-height:1;">×</button>
      <h3 style="margin:0 0 20px;font-size:18px;font-weight:600;color:#101828;">
        Enter the version name for the app «${esc(appName(app))}»
      </h3>
      <label style="display:block;font-size:14px;color:#344054;margin-bottom:6px;">
        Version name <span style="color:#e53e3e;">*</span>
      </label>
      <input class="abs-mi" type="text" placeholder="Enter a value"
        style="width:100%;box-sizing:border-box;padding:10px 14px;
               border:1px solid #d0d5dd;border-radius:8px;font-size:14px;
               outline:none;color:#344054;transition:border-color .15s;" />
      <div class="abs-me" style="display:none;color:#e53e3e;font-size:12px;margin-top:6px;"></div>
      <div style="display:flex;justify-content:flex-end;margin-top:24px;">
        <button class="abs-ms" style="background:#f5601d;color:#fff;border:none;
          border-radius:8px;padding:10px 24px;font-size:14px;font-weight:600;
          cursor:pointer;transition:opacity .15s;">Save</button>
      </div>`;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const input   = modal.querySelector('.abs-mi');
    const saveBtn = modal.querySelector('.abs-ms');
    const errEl   = modal.querySelector('.abs-me');

    input.focus();
    input.addEventListener('focus', () => { input.style.borderColor = '#f5601d'; });
    input.addEventListener('blur',  () => { input.style.borderColor = '#d0d5dd'; });

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    modal.querySelector('.abs-mc').addEventListener('click', close);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveBtn.click(); });

    saveBtn.addEventListener('click', async () => {
      const name = input.value.trim();
      if (!name) {
        errEl.textContent = 'Please enter a version name';
        errEl.style.display = 'block';
        input.focus();
        return;
      }

      saveBtn.disabled = true;
      saveBtn.style.opacity = '0.6';
      saveBtn.textContent = 'Saving…';
      errEl.style.display = 'none';

      try {
        const resp = await fetch(`${API_BASE}/${app.id}/versions`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...extraHeaders },
          body: JSON.stringify({ name }),
        });

        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.message || `HTTP ${resp.status}`);

        // Invalidate cache, re-render panel
        delete versionsCache[app.id];
        const versions = await fetchVersions(app.id);
        renderVersionsInPanel(panel, app, versions);

        // Navigate to the new version if API returned it (hard reload — SPA needs it for fresh data)
        const newVersion = data.data;
        if (newVersion?.id) navigateToVersion(app.id, newVersion.id, true);

        close();
      } catch (err) {
        errEl.textContent = err.message || 'Error creating version';
        errEl.style.display = 'block';
        saveBtn.disabled = false;
        saveBtn.style.opacity = '1';
        saveBtn.textContent = 'Save';
      }
    });
  }

  // ── Delete version modal ──────────────────────────────────────────────────
  function showDeleteVersionModal(app, version, panel) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,0.4);
      display:flex;align-items:center;justify-content:center;
      z-index:99999;
    `;

    const modal = document.createElement('div');
    modal.style.cssText = `
      background:#fff;border-radius:12px;padding:28px 32px;
      width:420px;max-width:90vw;position:relative;
      box-shadow:0 20px 60px rgba(0,0,0,0.15);
    `;
    modal.innerHTML = `
      <p style="margin:0 0 24px;font-size:16px;font-weight:600;color:#101828;line-height:1.5;">
        Do you really want to delete the<br>
        «${esc(version.name)}» of the «${esc(appName(app))}» app?
      </p>
      <div style="display:flex;justify-content:flex-end;gap:10px;">
        <button class="abs-dc" style="background:#fff;color:#344054;border:1px solid #d0d5dd;
          border-radius:8px;padding:9px 20px;font-size:14px;font-weight:500;cursor:pointer;
          transition:background .15s;">Cancel</button>
        <button class="abs-dd" style="background:#f5601d;color:#fff;border:none;
          border-radius:8px;padding:9px 20px;font-size:14px;font-weight:600;cursor:pointer;
          transition:opacity .15s;">Confirm</button>
      </div>
      <div class="abs-de" style="display:none;color:#e53e3e;font-size:12px;margin-top:10px;text-align:right;"></div>`;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const cancelBtn  = modal.querySelector('.abs-dc');
    const confirmBtn = modal.querySelector('.abs-dd');
    const errEl      = modal.querySelector('.abs-de');

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    cancelBtn.addEventListener('click', close);
    cancelBtn.onmouseenter = () => { cancelBtn.style.background = '#f9fafb'; };
    cancelBtn.onmouseleave = () => { cancelBtn.style.background = '#fff'; };

    confirmBtn.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      confirmBtn.style.opacity = '0.6';
      confirmBtn.textContent = 'Deleting…';
      errEl.style.display = 'none';

      try {
        const resp = await fetch(`${API_BASE}/${app.id}/versions/${version.id}`, {
          method: 'DELETE',
          credentials: 'include',
          headers: { Accept: 'application/json', ...extraHeaders },
        });

        if (!resp.ok) {
          const data = await resp.json().catch(() => ({}));
          throw new Error(data.message || `HTTP ${resp.status}`);
        }

        // Invalidate cache and re-render
        delete versionsCache[app.id];
        const versions = await fetchVersions(app.id);
        renderVersionsInPanel(panel, app, versions);

        close();
      } catch (err) {
        errEl.textContent = err.message || 'Error deleting version';
        errEl.style.display = 'block';
        confirmBtn.disabled = false;
        confirmBtn.style.opacity = '1';
        confirmBtn.textContent = 'Confirm';
      }
    });
  }

  // ── 10. Navigation ─────────────────────────────────────────────────────────
  function navigateToVersion(appId, versionId, hardReload = false) {
    const path = `${API_PREFIX}/builder/constructor/${appId}/${versionId}/authorizations`;
    if (hardReload) {
      saveState();
      location.href = path;
    } else {
      history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  }

  // ── Session state (survives hard reload) ───────────────────────────────────
  const STATE_KEY = '__abs_state__';

  function saveState() {
    const query = document.getElementById('abs-input')?.value || '';
    sessionStorage.setItem(STATE_KEY, JSON.stringify({ query, expandedAppId }));
  }

  function popState() {
    try {
      const raw = sessionStorage.getItem(STATE_KEY);
      if (!raw) return null;
      sessionStorage.removeItem(STATE_KEY); // consume once
      return JSON.parse(raw);
    } catch { return null; }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function appName(app) {
    return app.info?.titleRu || app.info?.titleEn || `App #${app.id}`;
  }

  function versionStatus(status) {
    switch (status) {
      case 0: return { text: 'Private',    style: 'background:#f2f4f7;color:#667085;' };
      case 1: return { text: 'Moderation', style: 'background:#eff8ff;color:#1570ef;' };
      case 2: return { text: 'Public',     style: 'background:#ecfdf3;color:#027a48;' };
      case 3: return { text: 'By link',    style: 'background:#fefce8;color:#a16207;' };
      default: return { text: String(status), style: 'background:#f2f4f7;color:#667085;' };
    }
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr.replace(' ', 'T'));
      return 'Created on: ' + d.toLocaleDateString('ru-RU', { day:'2-digit', month:'2-digit', year:'numeric' });
    } catch { return dateStr; }
  }

  function waitForSidebar(timeout = 20000) {
    return new Promise((resolve, reject) => {
      const find = () => {
        const el = document.querySelector('.al-universal-sidebar-scrollable');
        return el && el.children.length >= 2 ? el : null;
      };

      const found = find();
      if (found) return resolve(found);

      const obs = new MutationObserver(() => {
        const el = find();
        if (el) { obs.disconnect(); clearTimeout(t); resolve(el); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      const t = setTimeout(() => { obs.disconnect(); reject(new Error('Sidebar not found')); }, timeout);
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function highlight(text, query) {
    if (!query) return text;
    const i = text.toLowerCase().indexOf(query.toLowerCase());
    if (i === -1) return text;
    return (
      text.slice(0, i) +
      `<mark style="background:#fff3eb;color:#f5601d;border-radius:2px;padding:0 1px;">${text.slice(i, i + query.length)}</mark>` +
      text.slice(i + query.length)
    );
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
})();
