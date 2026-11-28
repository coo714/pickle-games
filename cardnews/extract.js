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
    bad: '주소를 찾지 못했어요. 기사·블로그 주소(https://…)를 넣어 주세요.',
    private: '내 컴퓨터·사내망 주소는 열 수 없어요. 누구나 볼 수 있는 공개 주소를 넣어 주세요.',
    blocked: '이 사이트는 보안을 위해 자동 읽기가 막혀 있어요. 불러오지 못했으니 아래 ‘직접 입력’을 열어 본문을 붙여넣어 주세요.',
    rate: '지금 불러오기 요청이 잠깐 몰렸어요(1분에 20건까지). 30초쯤 뒤에 다시 눌러 주세요.',
    notfound: '주소가 없거나 삭제된 페이지예요(404). 주소를 다시 확인해 주세요.',
    empty_body: '본문을 찾지 못했어요. 사진·영상만 있는 페이지이거나 자동 읽기를 막아 둔 사이트예요. 아래 ‘직접 입력’을 열어 붙여넣어 주세요.',
    network: '인터넷 연결이나 사이트 응답이 느려 본문을 불러오지 못했어요. 잠시 뒤 다시 눌러 보시고, 계속 안 되면 아래 ‘직접 입력’을 열어 주세요.',
    timeout: '사이트 응답이 너무 느려 불러오기를 멈췄어요. 잠시 뒤 다시 시도하거나 아래 ‘직접 입력’을 열어 주세요.',
    too_long: '페이지가 너무 커서 자동으로 읽지 못했어요. 아래 ‘직접 입력’을 열어 본문만 붙여넣어 주세요.'
  };

  function message(code) {
    return MSG[code] || MSG.network;
  }

  /* 글자 수 세기 (괄호 짝 확인용) */
  function countChar(s, ch) {
    var n = 0;
    for (var i = 0; i < s.length; i += 1) if (s.charAt(i) === ch) n += 1;
    return n;
  }

  /** 주소 끝에 붙은 마침표·쉼표·따옴표·괄호를 떼어 낸다. */
  function trimUrlTail(s) {
    var prev;
    do {
      prev = s;
      s = s.replace(/[.,;:!?'"“”‘’`»…、。·]+$/, '');
      var last = s.slice(-1);
      if (last === ')' && countChar(s, ')') > countChar(s, '(')) s = s.slice(0, -1);
      else if (last === ']' && countChar(s, ']') > countChar(s, '[')) s = s.slice(0, -1);
      else if (last === '}' && countChar(s, '}') > countChar(s, '{')) s = s.slice(0, -1);
      else if (last === '>' || last === '」' || last === '』' || last === '】' || last === '〉') s = s.slice(0, -1);
    } while (s !== prev);
    return s;
  }

  /** 문자열 어디에 있든 http(s) 주소를 먼저 찾아낸다.
      공유하기로 복사한 문자열은 "[단독] 제목… https://주소" 처럼 제목이 앞에 붙는다. */
  function findUrlInText(text) {
    var re = /https?:\/\/[^\s<>"'“”‘’`]+/ig;
    var m;
    while ((m = re.exec(text))) {
      var cand = trimUrlTail(m[0]);
      if (/^https?:\/\/[^\s\/]/i.test(cand)) return cand;
    }
    return '';
  }

  /* 스킴 없이 들어온 'www.mk.co.kr/…' 같은 덩어리 */
  var BARE_DOMAIN = /^(?:[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{2,5})?(?:[\/?#][^\s]*)?$/i;

  function findBareDomain(text) {
    var parts = String(text).split(/[\s<>"'“”‘’`()\[\]{}]+/);
    for (var i = 0; i < parts.length; i += 1) {
      var t = trimUrlTail(parts[i].replace(/^[.,;:!?'"“”‘’`]+/, ''));
      if (!t || /\s/.test(t)) continue;
      if (BARE_DOMAIN.test(t)) return 'https://' + t;
    }
    return '';
  }

  /** 사이트 구조 때문에 본문이 비어 오는 주소를 본문이 열리는 주소로 바꾼다.
      · 네이버 블로그 PC 주소(blog.naver.com/{id}/{logNo})는 본문이 iframe 안에 있어
        추출기가 빈 본문을 받는다 → PostView.naver(본문 직접) 주소로 바꾼다.
      · 네이버 뉴스 모바일 /mnews/article/ 은 404 → /article/ 로 바꾼다. */
  function normalizeForReader(u) {
    var host = u.hostname.toLowerCase();
    var path = u.pathname || '/';
    var out = { url: u.href, alternates: [] };

    if (/(^|\.)blog\.naver\.com$/.test(host)) {
      var m = /^\/([A-Za-z0-9._\-]+)\/(\d{4,})\/?$/.exec(path);
      var blogId = m ? m[1] : '';
      var logNo = m ? m[2] : '';
      if (!blogId || !logNo) {
        blogId = u.searchParams.get('blogId') || '';
        logNo = u.searchParams.get('logNo') || '';
      }
      if (blogId && /^\d{4,}$/.test(logNo)) {
        out.url = 'https://blog.naver.com/PostView.naver?blogId=' +
          encodeURIComponent(blogId) + '&logNo=' + logNo;
        var mobile = 'https://m.blog.naver.com/' + encodeURIComponent(blogId) + '/' + logNo;
        if (mobile !== u.href) out.alternates.push(mobile);
      }
    }

    if (/^m\.news\.naver\.com$/.test(host) && /^\/mnews\/article\//i.test(path)) {
      var fixed = path.replace(/^\/mnews\/article\//i, '/article/');
      out.url = 'https://m.news.naver.com' + fixed + (u.search || '');
      out.alternates.push('https://n.news.naver.com' + fixed + (u.search || ''));
    }

    return out;
  }

  /** 사용자가 넣은 문자열을 실제 주소로 다듬고 검사한다. */
  function parseUrl(input) {
    var rawText = String(input == null ? '' : input).replace(/[\u200b-\u200d\ufeff]/g, '').trim();
    if (!rawText) return { ok: false, error: 'empty' };

    /* 위험한 스킴은 문자열 어디에서 시작하든 먼저 막는다 */
    if (/^(?:javascript|vbscript|data|file|about|blob|jar|chrome|ms-|view-source)\s*:/i.test(rawText)) {
      return { ok: false, error: 'scheme' };
    }

    var s = findUrlInText(rawText);
    if (!s) {
      s = findBareDomain(rawText);
      if (!s) return { ok: false, error: 'bad' };
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

    var norm = normalizeForReader(u);
    var normalized;
    try { normalized = new URL(norm.url); } catch (e2) { normalized = u; }

    return {
      ok: true,
      url: norm.url,
      host: normalized.hostname.toLowerCase(),
      original: u.href,
      alternates: norm.alternates
    };
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
  var NOISE_STRONG = /(자동으로\s*줄인|세\s*줄\s*요약\s*(?:기술|입니다|서비스|요약)|선호하는\s*출처|출처로\s*추가|본문과\s*함께\s*읽어|기사\s*본문과|구글\s*검색에서|언론사에서\s*(?:선정|직접)|무단\s*전재|무단\s*재배포|재배포\s*금지|저작권자|Copyright|All rights reserved|ⓒ|©|AI\s*요약은|OpenAI의\s*최신\s*기술|기사\s*본문을\s*함께|AI\s*해설은\s*뉴스의|정확한\s*내용은\s*기사\s*본문|본\s*서비스는\s*AI|투자\s*권유|신고\s*사유\s*선택)/i;

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
    /* 양끝이 짝으로 감싸인 따옴표만 뗀다 — ‘10kg 에어컨’처럼 제목 안의 인용부호는 살린다 */
    var quoted = /^(["'“”‘’]+)([\s\S]*)(["'“”‘’]+)$/.exec(t);
    if (quoted && !/["'“”‘’]/.test(quoted[2])) t = quoted[2].trim();
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  }

  /** 제목이 70자를 넘으면 카드 제목으로 쓰기 좋게 단어 경계에서 자른다 */
  function clipTitle(t, max) {
    max = max || 70;
    if (t.length <= max) return t;
    var cut = t.slice(0, max);
    var sp = cut.lastIndexOf(' ');
    if (sp > max * 0.6) cut = cut.slice(0, sp);
    /* 잘린 끝에 걸린 영어 연결어(in·of·the…)는 함께 떼어 낸다 */
    cut = cut.replace(/\s+(?:in|on|of|to|and|the|a|an|for|with|at|by|from|as|its|their|his|her|is|are|was|were|that|but|or)$/i, '');
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

  function toLines(body, srcMap) {
    var raw = String(body || '').replace(/\r\n?/g, '\n');
    var chunks = raw.split('\n');

    /* 굵은 글씨로 된 소제목 오른쪽에 본문이 붙어 있으면(네이버 뉴스 등) 줄을 나눈다.
       한 줄 안에서 짝을 이룬 굵은 글씨는 문장 속 강조이므로 건드리지 않는다. */
    var out = [], outSrc = [];
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
      for (var q = 0; q < pieces.length; q += 1) { out.push(pieces[q]); outSrc.push(i); }
    }

    var clean = [];
    for (var k = 0; k < out.length; k += 1) {
      var t = stripInline(out[k]);
      if (!t) continue;
      if (clean.length && clean[clean.length - 1] === t) continue;
      clean.push(t);
      if (srcMap) srcMap.push(outSrc[k]);
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
    return { paragraphs: paras, start: chosen.start, end: chosen.end };
  }

  var MAX_CHARS = 6000;      // 카드뉴스 7장에 넣기 좋은 분량
  var MAX_PARAS = 24;

  /* ---------------------------------------------------------------------
     3-0) 본문 사진(대표 이미지) 뽑기
     ---------------------------------------------------------------------
     Jina Reader 는 본문 이미지를 markdown 이미지(![설명](주소))로 남긴다.
     그중에서 로고·아이콘·1px 트래커·광고 배너·관련기사 썸네일을 걷어내고
     본문 안에 놓인 사진을 최대 3장 고른다. (카드 배경으로 쓰기 좋은 것)
     --------------------------------------------------------------------- */

  var IMG_JUNK = /(\/logo|logo\.|logo_|_logo|logos\/|\/icon|icon\.|icon_|_icon|icon\/|sprite|spacer|blank\.|pixel\.|tracker|beacon|favicon|\/css\/|\/common\/|\/static\/|emoji|avatar|btn_|\/btn|button|banner|advert|\/ad\/|\/ads\/|adimg|ad_|sponsor|watermark|placeholder|noimage|no_image|no-image|badge|transparent|1x1)/i;

  var IMG_ALT_JUNK = /^(?:이미지|image|photo|사진|프로필|프로파일|로고|광고|배너|닫기|재생|동영상|아이콘|화살표|더보기|바로가기|구독|멤버십|이벤트|썸네일)$/i;

  var IMG_ALT_AD = /(광고|배너|이벤트|구독|멤버십|프로모|앱 ?설치|다운로드|쿠폰|할인|공모전|설문)/;

  /** 주소에 적힌 크기 힌트(쿼리·경로)로 너무 작은 이미지를 걸러 낸다. */
  function imgTooSmall(url) {
    var m = /[?&](?:w|width)=(\d{1,4})/i.exec(url);
    if (m && +m[1] < 220) return true;
    m = /[?&](?:h|height)=(\d{1,4})/i.exec(url);
    if (m && +m[1] < 160) return true;
    m = /[?&]type=([a-z]{0,3})(\d{1,4})(?:_(\d{1,4}))?/i.exec(url);
    if (m) {
      var a = +m[2], b = m[3] ? +m[3] : 0;
      if (a && a < 220) return true;
      if (b && b < 160) return true;
    }
    // 파일명에 박힌 크기 표시 (_100_, -80x80 등)
    if (/(?:^|[^\d])(\d{1,3})x(\d{1,3})(?:[^\d]|$)/.test(url)) {
      var wh = /(?:^|[^\d])(\d{1,3})x(\d{1,3})(?:[^\d]|$)/.exec(url);
      if (+wh[1] < 220 || +wh[2] < 160) return true;
    }
    return false;
  }

  /** 사진으로 볼 만한 주소인가 (확장자·경로 힌트) */
  function looksLikePhoto(url) {
    if (/\.(?:jpe?g|png|webp|gif|avif|bmp)(?:[?#]|$)/i.test(url)) return true;
    if (/\.img(?:[?#]|$)/i.test(url)) return true;                       // MSN(akamaized)
    if (/\/(?:photo|photos|image|images|img|cms|mpic|thumbnail|resizer)\//i.test(url)) return true;
    if (/^https?:\/\/img[\w-]*\./i.test(url)) return true;
    return false;
  }

  function isPhotoUrl(url, alt) {
    if (!/^https?:\/\//i.test(String(url || ''))) return false;
    if (/\.svg(?:[?#]|$)/i.test(url)) return false;
    if (IMG_JUNK.test(url)) return false;
    if (alt && IMG_ALT_JUNK.test(String(alt).trim())) return false;
    if (alt && IMG_ALT_AD.test(String(alt))) return false;
    if (imgTooSmall(url)) return false;
    if (!looksLikePhoto(url)) return false;
    return true;
  }

  /** 같은 사진의 다른 크기(_P4 / _T2 / ?type=w773)를 하나로 묶기 위한 키 */
  function imgKey(url) {
    var base = String(url).split('#')[0].split('?')[0];
    var name = base.slice(base.lastIndexOf('/') + 1).toLowerCase();
    name = name.replace(/\.[a-z0-9]{2,5}$/, '');
    name = name.replace(/[_\-](?:p|t|s|m|v|w|h)\d{1,3}$/i, '');
    name = name.replace(/[_\-]\d{1,3}x\d{1,3}$/i, '');
    return (base.slice(0, base.lastIndexOf('/')) + '/' + name).toLowerCase();
  }

  /** markdown·HTML 에서 이미지 (주소, 설명, 줄번호, 링크 감싸기) 수집 */
  function collectImages(body) {
    var lines = String(body || '').replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      var m;
      var re = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
      while ((m = re.exec(line))) {
        /* [![사진](주소)](링크) — 링크로 감싼 이미지는 다른 기사·프로필로 가는 썸네일인 경우가 많다 */
        var wrap = '';
        if (m.index > 0 && line.charAt(m.index - 1) === '[') {
          var after = line.slice(m.index + m[0].length);
          var wm = /^\]\(([^)\s]+)\)/.exec(after);
          if (wm) wrap = wm[1];
        }
        out.push({ url: decodeEntities(m[2]).trim(), alt: decodeEntities(m[1] || '').trim(), line: i, wrap: wrap });
      }
      var re2 = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
      while ((m = re2.exec(line))) {
        var altm = /alt=["']([^"']*)["']/i.exec(m[0]);
        out.push({ url: decodeEntities(m[1]).trim(), alt: altm ? altm[1] : '', line: i, wrap: '' });
      }
    }
    return out;
  }

  /** 감싼 링크가 이 기사가 아닌 다른 곳(관련 기사·프로필·광고)을 가리키는가 */
  function linkElsewhere(wrap, imgUrl, pageUrl) {
    if (!wrap) return false;
    if (!/^https?:\/\//i.test(wrap)) return false;
    var path = function (u) {
      try { var x = new URL(String(u)); return x.hostname.toLowerCase() + x.pathname; } catch (e) { return String(u); }
    };
    var w = path(wrap), p = pageUrl ? path(pageUrl) : '', im = path(imgUrl);
    if (p && w === p) return false;                      // 이 기사로 돌아오는 링크
    if (w === im) return false;
    if (w.indexOf(im) === 0 || im.indexOf(w) === 0) return false;
    return true;
  }

  /** 수집한 이미지 후보 → 본문 사진 최대 3장
      cands[i].line 과 rawLines 는 같은 좌표(본문 원본 줄번호)다. */
  function pickImages(cands, rawLines, bodyRange, pageUrl) {
    var start = bodyRange ? bodyRange.start : -1;
    var end = bodyRange ? bodyRange.end : -1;
    var seen = {};
    var scored = [];

    for (var i = 0; i < cands.length; i += 1) {
      var c = cands[i];
      if (!isPhotoUrl(c.url, c.alt)) continue;
      if (linkElsewhere(c.wrap, c.url, pageUrl)) continue;
      var key = imgKey(c.url);
      if (seen[key]) continue;
      seen[key] = true;

      /* 목록 기호로 시작하는 줄은 ‘관련 기사·쇼츠’ 썸네일이다 */
      var isListItem = /^\s*(?:[*\-+\u2022]|\d+[.)])\s/.test(rawLines[c.line] || '');
      if (isListItem) continue;

      var sc = 0;
      var inBody = start >= 0 && c.line >= start && c.line <= end;
      if (inBody) sc += 6;
      if (c.alt && c.alt.length >= 5) sc += 1.5;
      if (c.alt && c.alt.length >= 12) sc += 1;
      if (/\/(?:photo|cms|mpic|article)\//i.test(c.url)) sc += 1.5;
      if (/\/resizer\/|\/thumbnail\//i.test(c.url)) sc += 0.5;
      scored.push({ url: c.url, alt: c.alt, line: c.line, sc: sc, inBody: inBody });
    }

    scored.sort(function (a, b) { return b.sc - a.sc || a.line - b.line; });
    var keep = scored.filter(function (s) { return s.inBody; });
    if (!keep.length) keep = scored.filter(function (s) { return s.sc >= 2; });
    if (!keep.length) keep = scored.filter(function (s) { return s.sc >= 1; });
    keep.sort(function (a, b) { return a.line - b.line; });

    var out2 = [];
    for (var k = 0; k < keep.length && out2.length < 3; k += 1) out2.push(keep[k].url);
    return out2;
  }

  /** Jina 응답 텍스트 → { title, paragraphs, text } */
  function parseReader(raw) {
    var meta = splitMeta(raw);
    var srcMap = [];
    var lines = toLines(meta.body, srcMap);
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

    /* 본문 사진 — 본문 덩어리 안에 있는 이미지를 먼저 고른다 */
    var rawLines = String(meta.body || '').replace(/\r\n?/g, '\n').split('\n');
    var range = null;
    if (srcMap.length && body.paragraphs.length) {
      var a = srcMap[Math.min(body.start, srcMap.length - 1)];
      var b = srcMap[Math.min(body.end == null ? body.start : body.end, srcMap.length - 1)];
      range = { start: Math.min(a, b), end: Math.max(a, b) };
    }
    var images = pickImages(collectImages(meta.body), rawLines, range, meta.source || '');

    return {
      ok: paras.length > 0,
      title: title,
      paragraphs: paras,
      text: text.trim(),
      images: images,
      chars: paras.reduce(function (a, p) { return a + p.length; }, 0),
      warning: meta.warning || '',
      source: meta.source || ''
    };
  }

  /* ---------------------------------------------------------------------
     3-1) MSN 뉴스 (msn.com)
     ---------------------------------------------------------------------
     msn.com 기사 페이지는 글자를 Shadow DOM 안에 그려서, 페이지 주소를 그대로
     Jina Reader 로 읽히면 본문이 비어 온다. 대신 MSN 이 쓰는 기사 JSON
       https://assets.msn.com/content/view/v2/Detail/{locale}/{기사ID}
     은 CORS 가 열려 있어 본문(HTML)과 제목, 원문 주소(sourceHref)를 그대로 받는다.
     --------------------------------------------------------------------- */

  var MSN_HOST = /(^|\.)msn\.com$/i;

  /** msn.com 기사 주소 → { locale, id, api } (기사 주소가 아니면 null) */
  function msnTarget(url) {
    var u;
    try { u = new URL(String(url)); } catch (e) { return null; }
    if (!MSN_HOST.test(u.hostname.toLowerCase())) return null;

    var path = (u.pathname || '/');
    /* 기사 ID 는 주소 끝의 /ar-XXXXXXXX 꼴 (영상은 /vi-). 슬러그에 섞인
       'ar-' 를 피하려고 경로 전체에서 마지막 일치를 쓴다. */
    var re = /(?:^|\/)(?:ar|vi)-([A-Za-z0-9]{4,})(?=$|\/)/g;
    var m, id = '';
    while ((m = re.exec(path))) id = m[1];
    if (!id) return null;

    /* 언어·지역 코드는 주소 첫 칸(/ko-kr/…). 없으면 한국어(ko-kr)로 본다. */
    var loc = /^\/([a-z]{2}-[a-z]{2,4})(?:\/|$)/i.exec(path);
    var locale = loc ? loc[1].toLowerCase() : 'ko-kr';

    return {
      locale: locale,
      id: id,
      api: 'https://assets.msn.com/content/view/v2/Detail/' + locale + '/' + encodeURIComponent(id)
    };
  }

  /** 기사 본문 HTML → 줄 단위 평문 (문단·목록 경계에서 줄을 나눈다) */
  function htmlToText(html) {
    var s = String(html == null ? '' : html);
    s = s.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ');
    s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
    s = s.replace(/<\s*(?:img|figure|iframe|video|audio|source|svg|noscript|button|input|hr)\b[^>]*>/gi, ' ');
    s = s.replace(/<\s*\/\s*(?:p|div|li|ul|ol|h[1-6]|blockquote|figcaption|tr|td|section|article|table)\s*>/gi, '\n');
    s = s.replace(/<\s*(?!\/)[^>]*>/g, ' ');          // 남은 여는 태그
    s = s.replace(/<[^>]*>/g, ' ');                    // 남은 닫는 태그
    return decodeEntities(s);
  }

  /** MSN 기사 JSON(Reader 응답에 실려 온 것) → { title, paragraphs, text, source } */
  function parseMsnJson(raw) {
    var text = String(raw == null ? '' : raw);
    var mark = text.search(/^Markdown Content:\s*$/m);
    var from = mark >= 0 ? text.indexOf('{', mark) : text.indexOf('{');
    if (from < 0) return null;

    var data;
    try { data = JSON.parse(text.slice(from)); } catch (e) { return null; }
    if (!data || typeof data !== 'object') return null;

    var body = data.body;
    if (Array.isArray(body)) body = body.join('');
    var lines = toLines(htmlToText(body));
    var picked = pickBody(lines);
    var paras = picked.paragraphs;

    var kept = [], used = 0;
    for (var pi = 0; pi < paras.length && kept.length < MAX_PARAS; pi += 1) {
      if (used && used + paras[pi].length > MAX_CHARS) break;
      kept.push(paras[pi]);
      used += paras[pi].length;
    }
    if (kept.length) paras = kept;

    var title = cleanTitle(String(data.title == null ? '' : data.title).replace(/<[^>]*>/g, ' '));
    if (!title && data.abstract) {
      title = cleanTitle(String(data.abstract).replace(/<[^>]*>/g, ' '));
    }
    if (!title && paras.length) title = paras[0].replace(/[.!?…]$/, '').slice(0, 60);
    title = clipTitle(title, 70);

    if (title && paras.length && paras[0] === title) paras = paras.slice(1);

    var source = data.sourceHref && /^https?:\/\//i.test(data.sourceHref) ? data.sourceHref : '';
    var joined = (title ? title + '\n\n' : '') + paras.join('\n\n');

    return {
      ok: paras.length > 0,
      title: title,
      paragraphs: paras,
      text: joined.trim(),
      images: pickMsnImages(data),
      chars: paras.reduce(function (a, p) { return a + p.length; }, 0),
      warning: '',
      source: source
    };
  }

  /** MSN 기사 JSON → 대표 사진 최대 3장 (imageResources 우선, 본문 <img> 보충) */
  function pickMsnImages(data) {
    var out = [];
    var seen = {};
    var list = Array.isArray(data && data.imageResources) ? data.imageResources : [];

    var scored = [];
    for (var i = 0; i < list.length; i += 1) {
      var it = list[i] || {};
      var url = String(it.url || '').trim();
      if (!/^https?:\/\//i.test(url)) continue;
      if (!isPhotoUrl(url, String(it.title || ''))) continue;
      var w = +it.width || 0, h = +it.height || 0;
      if (w && w < 400) continue;
      if (h && h < 250) continue;
      scored.push({ url: url, area: w * h, i: i });
    }
    scored.sort(function (a, b) { return (b.area - a.area) || (a.i - b.i); });

    for (var k = 0; k < scored.length && out.length < 3; k += 1) {
      var key = imgKey(scored[k].url);
      if (seen[key]) continue;
      seen[key] = true;
      out.push(scored[k].url);
    }

    if (out.length < 3) {
      var bodyImg = collectImages(String((data && data.body) || ''));
      var more = pickImages(bodyImg, [], null);
      for (var q = 0; q < more.length && out.length < 3; q += 1) {
        var kk = imgKey(more[q]);
        if (seen[kk]) continue;
        seen[kk] = true;
        out.push(more[q]);
      }
    }
    return out;
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
      if (res.status === 429) throw new Error('rate');
      if (res.status === 413) throw new Error('too_long');
      if (!res.ok) throw new Error('network');
      return res.text();
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      if (!err) throw new Error('network');
      if (err.message === 'notfound' || err.message === 'blocked' ||
          err.message === 'rate' || err.message === 'too_long' ||
          err.message === 'network') throw err;
      if (err.name === 'AbortError') throw new Error('timeout');
      throw new Error('network');
    });
  }

  /** MSN 기사 한 건 읽기 — 기사 JSON 이 비면 원문(sourceHref)으로 한 번 더 시도한다. */
  function readMsn(msn, check) {
    function fail(error, sourceHref) {
      if (error === 'rate' || error === 'timeout') {
        return Promise.resolve({ ok: false, error: error, host: check.host });
      }
      if (!sourceHref) return Promise.resolve({ ok: false, error: error || 'empty_body', host: check.host });
      return fetchText(sourceHref).then(function (raw) {
        if (/Target URL returned error 404/i.test(raw)) return { ok: false, error: 'notfound', host: check.host };
        if (/Target URL returned error (401|403|429)/i.test(raw)) return { ok: false, error: 'blocked', host: check.host };
        var parsed = parseReader(raw);
        if (!parsed.paragraphs.length || parsed.chars < 120) {
          return { ok: false, error: 'empty_body', host: check.host };
        }
        parsed.ok = true;
        parsed.host = check.host;
        parsed.url = sourceHref;
        parsed.via = sourceHref;
        return parsed;
      }).catch(function (err) {
        return { ok: false, error: (err && err.message) || 'network', host: check.host };
      });
    }

    return fetchText(msn.api).then(function (raw) {
      if (/Target URL returned error 404/i.test(raw)) return fail('notfound', '');
      if (/Target URL returned error (401|403|429)/i.test(raw)) return fail('blocked', '');
      var parsed = parseMsnJson(raw);
      if (!parsed) return fail('empty_body', '');
      parsed.host = check.host;
      parsed.url = msn.api;
      if (!parsed.paragraphs.length || parsed.chars < 120) return fail('empty_body', parsed.source);
      parsed.ok = true;
      return parsed;
    }).catch(function (err) {
      return fail((err && err.message) || 'network', '');
    });
  }

  /** 주소 → 파싱 결과 (실패하면 { ok:false, error })
      본문이 비어 오는 사이트는 준비된 대체 주소(alternates)를 차례로 한 번 더 시도한다. */
  function readUrl(url) {
    var check = parseUrl(url);
    if (!check.ok) return Promise.resolve({ ok: false, error: check.error });

    var msn = msnTarget(check.original || check.url);
    if (msn) return readMsn(msn, check);

    var list = [check.url];
    var alts = check.alternates || [];
    for (var i = 0; i < alts.length; i += 1) {
      if (list.indexOf(alts[i]) < 0) list.push(alts[i]);
    }

    var failure = { ok: false, error: 'network' };

    function tryOne(idx) {
      if (idx >= list.length) return Promise.resolve(failure);
      return fetchText(list[idx]).then(function (raw) {
        if (/Target URL returned error 404/i.test(raw)) return { ok: false, error: 'notfound' };
        if (/Target URL returned error (401|403|429)/i.test(raw)) return { ok: false, error: 'blocked' };
        var parsed = parseReader(raw);
        parsed.host = check.host;
        parsed.url = list[idx];
        if (!parsed.paragraphs.length || parsed.chars < 120) {
          return { ok: false, error: 'empty_body', host: check.host };
        }
        parsed.ok = true;
        if (idx > 0) parsed.via = list[idx];
        return parsed;
      }).catch(function (err) {
        return { ok: false, error: (err && err.message) || 'network' };
      }).then(function (res) {
        if (res && res.ok) return res;
        failure = res || { ok: false, error: 'network' };
        if (failure.error === 'rate') return failure;      // 우리 쪽 요청 한도 — 다시 시도해도 같다
        return tryOne(idx + 1);
      });
    }

    return tryOne(0);
  }

  global.CardNewsExtract = {
    parseUrl: parseUrl,
    parseReader: parseReader,
    readUrl: readUrl,
    message: message,
    isPhotoUrl: isPhotoUrl,
    pickImages: pickImages,
    collectImages: collectImages,
    pickMsnImages: pickMsnImages,
    stripInline: stripInline,
    isProse: isProse,
    toLines: toLines,
    pickBody: pickBody,
    msnTarget: msnTarget,
    parseMsnJson: parseMsnJson,
    htmlToText: htmlToText,
    READER_BASE: READER_BASE
  };
})(window);
