/* =========================================================================
   update.js — 버전 표시 · 새 버전 확인 · 알림 배너
   -------------------------------------------------------------------------
   · 현재 버전은 헤더의 #appVersion[data-version] 값을 그대로 쓴다.
   · 페이지를 열면 version.json 을 조용히 한 번 확인하고(실패하면 무시),
     서버 버전이 더 높을 때만 상단 배너를 띄운다.
   · [새 버전 확인] 버튼은 같은 확인을 직접 실행해 결과를 토스트로 알려준다.
   ========================================================================= */
(function () {
  'use strict';

  var VERSION_URL = './version.json';
  var TIMEOUT_MS = 4000;
  var DISMISS_KEY = 'cardnews_update_dismissed';

  var $ = function (sel) { return document.querySelector(sel); };

  var verEl = $('#appVersion');
  var banner = $('#updateBanner');
  var bannerTitle = $('#ubTitle');
  var bannerNote = $('#ubNote');
  var reloadBtn = $('#updateReloadBtn');
  var closeBtn = $('#updateCloseBtn');
  var checkBtn = $('#checkUpdateBtn');

  var CURRENT = String((verEl && verEl.dataset.version) || '1.1.0').replace(/^v/i, '');
  var latest = '';

  /* "1.2.10" > "1.2.9" — 숫자 단위로 비교한다. 형식이 다르면 0(같음) 취급. */
  function compareVersions(a, b) {
    var pa = String(a == null ? '' : a).trim().replace(/^v/i, '').split(/[.\-+]/);
    var pb = String(b == null ? '' : b).trim().replace(/^v/i, '').split(/[.\-+]/);
    var len = Math.max(pa.length, pb.length);
    for (var i = 0; i < len; i += 1) {
      var na = parseInt(pa[i], 10);
      var nb = parseInt(pb[i], 10);
      if (isNaN(na)) na = 0;
      if (isNaN(nb)) nb = 0;
      if (na !== nb) return na > nb ? 1 : -1;
    }
    return 0;
  }

  function toast(msg) {
    var t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.classList.remove('on'); }, 2400);
  }

  function dismissed(version) {
    try { return sessionStorage.getItem(DISMISS_KEY) === version; } catch (e) { return false; }
  }

  function rememberDismiss(version) {
    try { sessionStorage.setItem(DISMISS_KEY, version); } catch (e) { /* 저장 못 해도 무시 */ }
  }

  function showBanner(version, notes) {
    latest = version;
    if (!banner) return;
    if (bannerTitle) bannerTitle.textContent = '새 버전 v' + version + '이 있어요!';
    if (bannerNote) bannerNote.textContent = notes ? String(notes) : ('지금은 v' + CURRENT + '을 쓰고 있어요.');
    banner.hidden = false;
  }

  function hideBanner() {
    if (banner) banner.hidden = true;
  }

  /* version.json 한 번 읽기 — 실패·오프라인은 조용히 null */
  function loadRemoteVersion() {
    if (typeof fetch !== 'function') return Promise.resolve(null);
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, TIMEOUT_MS) : null;
    return fetch(VERSION_URL + '?t=' + Date.now(), {
      cache: 'no-store',
      credentials: 'omit',
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      if (!res || !res.ok) return null;
      return res.json();
    }).then(function (data) {
      if (!data || typeof data.version !== 'string' || !data.version.trim()) return null;
      return { version: data.version.trim().replace(/^v/i, ''), notes: data.notes || '' };
    }).catch(function () {
      return null;
    }).then(function (result) {
      if (timer) clearTimeout(timer);
      return result;
    });
  }

  /* manual=true → 버튼으로 직접 확인: 결과를 항상 알려준다. */
  function check(manual) {
    if (checkBtn && manual) {
      checkBtn.disabled = true;
      checkBtn.textContent = '확인 중…';
    }
    return loadRemoteVersion().then(function (remote) {
      if (!remote) {
        if (manual) toast('버전을 확인하지 못했어요. 연결을 확인해 주세요.');
        return null;
      }
      if (compareVersions(remote.version, CURRENT) > 0) {
        if (!manual && dismissed(remote.version)) return remote;
        showBanner(remote.version, remote.notes);
        if (manual) toast('새 버전 v' + remote.version + '이 있어요!');
      } else {
        if (manual) toast('최신 버전(v' + CURRENT + ')을 쓰고 있어요.');
      }
      return remote;
    }).then(function (remote) {
      if (checkBtn) {
        checkBtn.disabled = false;
        checkBtn.textContent = '새 버전 확인';
      }
      return remote;
    });
  }

  function bind() {
    if (checkBtn) checkBtn.addEventListener('click', function () { check(true); });
    if (reloadBtn) reloadBtn.addEventListener('click', function () {
      try { location.reload(); } catch (e) { location.href = location.href; }
    });
    if (closeBtn) closeBtn.addEventListener('click', function () {
      hideBanner();
      if (latest) rememberDismiss(latest);
    });
  }

  function boot() {
    bind();                                   /* DOMContentLoaded 뒤에 실행되므로 바로 붙인다. */
    setTimeout(function () { check(false); }, 500);
  }

  /* 테스트용 핸들 */
  window.CardNewsUpdate = {
    current: CURRENT,
    compareVersions: compareVersions,
    check: check,
    showBanner: showBanner,
    hideBanner: hideBanner,
    bannerEl: banner
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
