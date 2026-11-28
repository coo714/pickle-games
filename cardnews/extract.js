/* =========================================================================
   extract.js — 웹페이지 주소(URL) → 제목 + 본문 자동 추출
   -------------------------------------------------------------------------
   정적 페이지(GitHub Pages)에서 브라우저 fetch 로 남의 사이트 HTML 을 직접
   읽으면 CORS 로 막힌다. 그래서 공개 본문 추출기인 Jina Reader
   (https://r.jina.ai/<주소>) 를 거쳐 마크다운 텍스트를 받아 온 뒤,
   메뉴·광고·이미지·링크 껍데기를 걷어내고 "제목 + 핵심 문단"만 남긴다.

   · http/https 주소만 허용, 내부망·localhost·file·javascript 차단
   · 받아 온 텍스트는 문자열로만 다룬다 (원격 스크립트 실행 없음)
   ========================================================================= */
(function (global) {
  'use strict';

  var READER_BASE = 'https://r.jina.ai/';
  var TIMEOUT_MS = 25000;

  /* ---------------------------------------------------------------------
     1) 주소 검사
     --------------------------------------------------------------------- */
  var PRIVATE_HOST = [
    /^localhost$/i,
    /^localhost\..+$/i,
    /^127\./,
    /^0\.0\.0\.0$/,
    /^10\./,
    /^192\.168\./,
    /^169\.254\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^\[?::1\]?$/,
    /^\[?f[cd][0-9a-f]{2}:/i,
    /\.local$/i,
    /\.internal$/i,
    /\.home\.arpa$/i
  ];

  var MSG = {
    empty: '주소를 넣어 주세요. 예: https://news.example.com/article/123',
    scheme: 'http:// 또는 https:// 주소만 불러올 수 있어요.',
    bad: '주소 형식을 확인해 주세요. 예: https://news.example.com/article/123',
    private: '내 컴퓨터·사내망 주소는 열 수 없어요. 누구나 볼 수 있는 공개 주소를 넣어 주세요.',
    blocked: '이 사이트는 보안을 위해 자동 읽기가 막혀 있어요. 불러오지 못했으니 아래 ‘직접 입력’을 열어 본문을 붙여넣어 주세요.',
    notfound: '주소가 없거나 삭제된 페이지예요(404). 주소를 다시 확인해 주세요.',
    empty_body: '본문을 찾지 못했어요. 사진·영상만 있는 페이지이거나 자동 읽기를 막아 둔 사이트예요. 아래 ‘직접 입력’을 열어 붙여넣어 주세요.',
    network: '인터넷 연결이나 사이트 응답이 느려 본문을 불러오지 못했어요. 잠시 뒤 다시 눌러 보시고, 계속 안 되면 아래 ‘직접 입력’을 열어 주세요.',
    timeout: '사이트 응답이 너무 느려 불러오기를 멈췄어요. 잠시 뒤 다시 시도하거나 아래 ‘직접 입력’을 열어 주세요.',
    too_long: '페이지가 너무 커서 자동으로 읽지 못했어요. 아래 ‘직접 입력’을 열어 본문만 붙여넣어 주세요.'
  };

  function message(code) {
    return MSG[code] || MSG.network;
  }

  /** 사용자가 넣은 문자열을 실제 주소로 다듬고 검사한다. */
  function parseUrl(input) {
    var s = String(input == null ? '' : input).trim();
    if (!s) return { ok: false, error: 'empty' };

    s = s.split(/\s+/)[0];                       // 뒤에 붙은 설명·공백 제거
    s = s.replace(/^[<"'“”‘’(]+/, '').replace(/[>"'“”‘’)]+$/, '');

    var scheme = /^([a-z][a-z0-9+.\-]*):/i.exec(s);
    if (scheme && !/^https?$/i.test(scheme[1])) return { ok: false, error: 'scheme' };
    if (!scheme) {
      if (/^\/\//.test(s)) s = 'https:' + s;
      else if (/^[^\s/]+\.[^\s/]+/.test(s)) s = 'https://' + s;   // www.xxx.com/... 형태
      else return { ok: false, error: 'bad' };
    } else if (!/^https?:\/\//i.test(s)) {
      return { ok: false, error: 'scheme' };
    }

    var u;
    try { u = new URL(s); } catch (e) { return { ok: false, error: 'bad' }; }
    if (!/^https?:$/.test(u.protocol)) return { ok: false, error: 'scheme' };
    if (!u.hostname) return { ok: false, error: 'bad' };

    var host = u.hostname.toLowerCase();
    for (var i = 0; i < PRIVATE_HOST.length; i += 1) {
      if (PRIVATE_HOST[i].test(host)) return { ok: false, error: 'private' };
    }
    if (!/(\.|:)/.test(host)) return { ok: false, error: 'bad' };
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !/^[\d.]+$/.test(host)) {
      return { ok: false, error: 'bad' };
    }
    return { ok: true, url: u.href, host: host };
  }

  /* ---------------------------------------------------------------------
     2) 마크다운 → 줄 단위 텍스트 정리
     --------------------------------------------------------------------- */
  var ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    middot: '·', hellip: '…', mdash: '—', ndash: '–',
    ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', times: '×', rarr: '→'
  };

  function decodeEntities(s) {
    return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, function (m, body) {
      if (body.charAt(0) === '#') {
        var code = body.charAt(1).toLowerCase() === 'x'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        return isNaN(code) ? m : String.fromCodePoint(code);
      }
      var v = ENTITIES[body.toLowerCase()];
      return v == null ? m : v;
    });
  }

  function stripInline(s) {
    s = String(s == null ? '' : s);
    s = decodeEntities(s);
    s = s.replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/g, ' ');            // 이미지
    s = s.replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1');        // 링크 → 글자만
    s = s.replace(/\[\[[^\]]*\]\]/g, ' ');                                    // [[a]] 위키 각주
    s = s.replace(/\[\s*[A-Za-z0-9]{1,3}\s*\]/g, '');                          // [1] [a] 각주
    s = s.replace(/https?:\/\/[^\s)\]]+/g, ' ');                            // 맨 URL
    s = s.replace(/\(\s*\)/g, ' ');                                            // 빈 괄호
    s = s.replace(/\[\s*\]/g, ' ');
    s = s.replace(/\*\*|__|~~|`/g, '');                                     // 강조 기호
    s = s.replace(/(^|[\s(])_([^_\n]{1,60})_(?=[\s).,!?]|$)/g, '$1$2');      // _기울임_
    s = s.replace(/^\s*(?:[*+\-]|\d+[.)])\s+/, '');                          // 목록 기호
    s = s.replace(/^\s*#{1,6}\s*/, '');                                     // 제목 기호
    s = s.replace(/\\\\([\\`*_{}\[\]()#+\-.!>~|])/g, '$1');                  // 이스케이프
    s = s.replace(/\\_/g, '_');
    s = s.replace(/[\u00a0\u2007\u202f]/g, ' ');
    s = s.replace(/[\u200b-\u200d\ufeff]/g, '');
    s = s.replace(/([가-힣])\s+(은|는|이|가|을|를|의|과|와)(?=\s|$)/g, '$1$2');  // 조사 앞 띄어쓰기 정리
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }

  var NOISE_EXACT = /^(?:광고|ad|ads|닫기|더보기|접기|돌아가기|이전|다음|이전 ?다음|이전글|다음글|공유|공유하기|댓글|댓글 ?반응|추천 ?반응|북마크|스크랩|프린트|인쇄하기|글자 ?크기|글자 ?크기 ?변경하기|메뉴|메뉴 ?열기|검색|검색창 ?열기|로그인|로그아웃|구독|구독중|구독하기|마이페이지|홈|홈으로|top|맨 ?위로|위로|본문 ?바로가기|사용자 ?링크|주요뉴스|관련 ?기사|많이 ?본 ?뉴스|실시간|핫뉴스|에디터스 ?픽|편집자 ?추천|인기|포토|세 ?줄 ?요약|요약|기사 ?원문|설명 ?보기|삭제|확인|취소|확인 ?취소|레이어 ?닫기|편집|목차|각주|같이 ?보기|바깥 ?고리|외부 ?링크|저장|좋아요|슬퍼요|화나요|후속요청|전체 ?알림|알림|댓글 ?입력|목록|글쓰기|신고|차단|팔로우|공감|비공감)$/i;

  var NOISE_CONTAINS = /(구독\s*하기|카카오톡\s*채널|네이버\s*채널|이미지\s*확대|제보는|기사\s*원문|언론사\s*(?:구독|선택|홈)|기사\s*섹션|댓글\s*정책|클린봇|공감\s*순|비공감\s*순|로그인\s*(?:후|하고)|회원\s*가입|개인정보\s*처리\s*방침|이용약관|청소년\s*보호|광고\s*문의|앱\s*설치|다운로드\s*받기|바로\s*만나보세요|메인에서\s*바로|세\s*줄\s*요약|자동으로\s*줄인|본문과\s*함께\s*읽어야|구글에서\s*선호하는|구글\s*검색에서|출처로\s*추가)/i;

  /* 본문이 끝나는 지점 표시 — 내용과 상관없이 강한 신호만 */
  var END_MARK = /(저작권자\s*\(|\bc\s*\)\s*[가-힣]+\s*,?\s*무단|무단\s*전재|무단\s*재배포|재배포\s*금지|Copyright|All rights reserved|ⓒ|©)/i;

  /* 문장부호·길이와 상관없이 본문이 아닌 줄 */
  var NOISE_STRONG = /(자동으로\s*줄인|세\s*줄\s*요약\s*(?:기술|입니다|서비스|요약)|선호하는\s*출처|출처로\s*추가|본문과\s*함께\s*읽어|기사\s*본문과|구글\s*검색에서|언론사에서\s*(?:선정|직접)|무단\s*전재|무단\s*재배포|재배포\s*금지|저작권자|Copyright|All rights reserved|ⓒ|©)/i;

  /* 각주·참고문헌 목록(위키백과의 '↑ ...') */
  var CITATION = /^[↑▲※]\s*/;

  function isNoise(t) {
    if (!t) return true;
    if (NOISE_STRONG.test(t)) return true;
    if (NOISE_EXACT.test(t)) return true;
    if (CITATION.test(t)) return true;
    if (END_MARK.test(t)) return true;
    if (t.length <= 24 && NOISE_CONTAINS.test(t)) return true;
    if (t.length <= 60 && NOISE_CONTAINS.test(t) && !/[.!?…]$/.test(t)) return true;
    if (/^[-=_*~·•.\s]{3,}$/.test(t)) return true;
    return false;
  }

  /** 본문 문단으로 볼 만한 줄인가 */
  function isProse(t) {
    var n = t.length;
    if (n < 24) return false;
    if (isNoise(t)) return false;
    var koreanCjk = (t.match(/[가-힣]/g) || []).length;
    if (koreanCjk < 4 && !/[a-z]{4}/i.test(t)) return false;      // 숫자·기호만 있는 줄
    if (/[.!?…:]["'”’)\]』」]?$/.test(t)) return n >= 20;
    if (/(다|요|죠|네요|습니다|입니다|였다|한다|된다|됐다|밝혔다|전했다|말했다)$/.test(t)) return n >= 20;
    return n >= 70;                                               // 문장부호 없는 아주 긴 줄
  }

  function cleanTitle(raw) {
    var t = stripInline(String(raw || '').replace(/^\s*Title:\s*/i, ''));
    if (!t) return '';
    // "제목 | 사이트명" / "제목 - 사이트명" 같은 꼬리표 떼기
    var parts = t.split(/\s+[|·•/]\s+|\s+[-–—]{1,2}\s+|\s+::\s+/);
    if (parts.length > 1) {
      var head = parts[0].trim();
      var tail = parts.slice(1).join(' ').trim();
      if (head.length >= 8 && tail.length <= 24 && !/[.!?]$/.test(tail)) t = head;
    }
    t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').replace(/\s+/g, ' ').trim();
    return t;
  }

  /** 제목이 70자를 넘으면 카드 제목으로 쓰기 좋게 단어 경계에서 자른다 */
  function clipTitle(t, max) {
    max = max || 70;
    if (t.length <= max) return t;
    var cut = t.slice(0, max);
    var sp = cut.lastIndexOf(' ');
    if (sp > max * 0.6) cut = cut.slice(0, sp);
    return cut.replace(/[\s,·]+$/, '');
  }

  /* ---------------------------------------------------------------------
     3) Jina Reader 응답 파싱
     --------------------------------------------------------------------- */
  function splitMeta(raw) {
    var text = String(raw == null ? '' : raw);
    var meta = { title: '', source: '', warning: '', body: text };

    var idx = text.search(/^Markdown Content:\s*$/m);
    var head = idx >= 0 ? text.slice(0, idx) : '';
    if (idx >= 0) meta.body = text.slice(idx).replace(/^Markdown Content:\s*/, '');

    var mt = /^Title:\s*(.*)$/m.exec(head);
    if (mt) meta.title = mt[1].trim();
    var ms = /^URL Source:\s*(.*)$/m.exec(head);
    if (ms) meta.source = ms[1].trim();
    var mw = /^Warning:\s*(.*)$/m.exec(head);
    if (mw) meta.warning = mw[1].trim();

    // Jina 가 헤더 없이 본문만 준 경우(프록시 등)도 처리
    if (idx < 0 && /^(Title|URL Source):/m.test(text)) {
      var lines = text.split(/\r?\n/);
      var keep = [];
      for (var i = 0; i < lines.length; i += 1) {
        if (/^(Title|URL Source|Published Time|Warning):/i.test(lines[i])) continue;
        keep.push(lines[i]);
      }
      meta.body = keep.join('\n');
    }
    return meta;
  }

  function toLines(body) {
    var raw = String(body || '').replace(/\r\n?/g, '\n');
    var chunks = raw.split('\n');

    /* 굵은 글씨로 된 소제목 오른쪽에 본문이 붙어 있으면(네이버 뉴스 등) 줄을 나눈다.
       한 줄 안에서 짝을 이룬 굵은 글씨는 문장 속 강조이므로 건드리지 않는다. */
    var out = [];
    for (var i = 0; i < chunks.length; i += 1) {
      var line = chunks[i];
      var last = line.lastIndexOf('**');
      var pieces = [line];
      if (last > 0) {
        var head = line.slice(0, last);
        var openings = (head.match(/\*\*/g) || []).length;
        var after = line.slice(last + 2);
        if (openings % 2 === 0 && after && !/^[\s[(]/.test(after) && head.length >= 10) {
          pieces = [head + '**', after];
        }
      }
      for (var q = 0; q < pieces.length; q += 1) out.push(pieces[q]);
    }

    var clean = [];
    for (var k = 0; k < out.length; k += 1) {
      var t = stripInline(out[k]);
      if (!t) continue;
      if (clean.length && clean[clean.length - 1] === t) continue;
      clean.push(t);
    }
    return clean;
  }

  /** 본문이 이어지는 구간(문단 덩어리)을 찾는다 */
  function pickBody(lines) {
    var flags = lines.map(isProse);
    var runs = [];
    var i = 0;
    while (i < lines.length) {
      if (!flags[i]) { i += 1; continue; }
      var start = i, end = i, gap = 0, j = i + 1;
      while (j < lines.length) {
        if (flags[j]) { end = j; gap = 0; }
        else {
          if (END_MARK.test(lines[j])) break;
          gap += 1;
          if (gap > 3) break;
        }
        j += 1;
      }
      var total = 0;
      for (var k = start; k <= end; k += 1) if (flags[k]) total += lines[k].length;
      runs.push({ start: start, end: end, total: total });
      i = end + 1;
    }
    if (!runs.length) return { paragraphs: [], start: 0 };

    /* 가장 긴 덩어리 하나만 보지 않고, 앞쪽(기사 본문)에서 충분히 큰 첫 덩어리를 고른다.
       뒤쪽의 댓글·참고문헌·관련기사 목록이 본문을 이기는 것을 막는다. */
    var biggest = runs.reduce(function (a, r) { return r.total > a.total ? r : a; }, runs[0]);
    var chosen = biggest;
    for (var q = 0; q < runs.length; q += 1) {
      if (runs[q].total >= biggest.total * 0.5 && runs[q].total >= 150) { chosen = runs[q]; break; }
    }

    var paras = [];
    for (var p = chosen.start; p <= chosen.end; p += 1) {
      if (flags[p] && !END_MARK.test(lines[p])) paras.push(lines[p]);
    }
    return { paragraphs: paras, start: chosen.start };
  }

  var MAX_CHARS = 6000;      // 카드뉴스 7장에 넣기 좋은 분량
  var MAX_PARAS = 24;

  /** Jina 응답 텍스트 → { title, paragraphs, text } */
  function parseReader(raw) {
    var meta = splitMeta(raw);
    var lines = toLines(meta.body);
    var body = pickBody(lines);
    var paras = body.paragraphs;

    /* 앞에서부터 핵심 분량만 남긴다 */
    var kept = [], picked = 0;
    for (var pi = 0; pi < paras.length && kept.length < MAX_PARAS; pi += 1) {
      if (picked && picked + paras[pi].length > MAX_CHARS) break;
      kept.push(paras[pi]);
      picked += paras[pi].length;
    }
    if (kept.length) paras = kept;

    var title = cleanTitle(meta.title);
    if (!title) {
      // 본문 앞쪽의 짧은 제목줄을 제목으로
      for (var i = Math.max(0, body.start - 6); i < body.start; i += 1) {
        var cand = lines[i];
        if (cand && cand.length >= 8 && cand.length <= 70 && !isNoise(cand) && !/[.!?]$/.test(cand)) {
          title = cand;
        }
      }
    }
    if (!title && paras.length) {
      title = paras[0].replace(/[.!?…]$/, '').slice(0, 60);
    }
    title = clipTitle(title, 70);

    if (title && paras.length && paras[0] === title) paras = paras.slice(1);

    var text = (title ? title + '\n\n' : '') + paras.join('\n\n');

    return {
      ok: paras.length > 0,
      title: title,
      paragraphs: paras,
      text: text.trim(),
      chars: paras.reduce(function (a, p) { return a + p.length; }, 0),
      warning: meta.warning || '',
      source: meta.source || ''
    };
  }

  /* ---------------------------------------------------------------------
     4) 실제 불러오기
     --------------------------------------------------------------------- */
  function fetchText(url, opts) {
    opts = opts || {};
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, opts.timeout || TIMEOUT_MS) : null;

    var init = {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    };
    if (controller) init.signal = controller.signal;

    return fetch(READER_BASE + url, init).then(function (res) {
      if (timer) clearTimeout(timer);
      if (res.status === 404) throw new Error('notfound');
      if (res.status === 403 || res.status === 401) throw new Error('blocked');
      if (res.status === 429) throw new Error('blocked');
      if (res.status === 413) throw new Error('too_long');
      if (!res.ok) throw new Error('network');
      return res.text();
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      if (!err) throw new Error('network');
      if (err.message === 'notfound' || err.message === 'blocked' ||
          err.message === 'too_long' || err.message === 'network') throw err;
      if (err.name === 'AbortError') throw new Error('timeout');
      throw new Error('network');
    });
  }

  /** 주소 → 파싱 결과 (실패하면 { ok:false, error }) */
  function readUrl(url) {
    var check = parseUrl(url);
    if (!check.ok) return Promise.resolve({ ok: false, error: check.error });
    return fetchText(check.url).then(function (raw) {
      if (/Target URL returned error 404/i.test(raw)) return { ok: false, error: 'notfound' };
      if (/Target URL returned error (401|403|429)/i.test(raw)) return { ok: false, error: 'blocked' };
      var parsed = parseReader(raw);
      parsed.host = check.host;
      parsed.url = check.url;
      if (!parsed.paragraphs.length) return { ok: false, error: 'empty_body', host: check.host };
      if (parsed.chars < 120) return { ok: false, error: 'empty_body', host: check.host };
      parsed.ok = true;
      return parsed;
    }).catch(function (err) {
      return { ok: false, error: (err && err.message) || 'network' };
    });
  }

  global.CardNewsExtract = {
    parseUrl: parseUrl,
    parseReader: parseReader,
    readUrl: readUrl,
    message: message,
    stripInline: stripInline,
    isProse: isProse,
    toLines: toLines,
    pickBody: pickBody,
    READER_BASE: READER_BASE
  };
})(window);
