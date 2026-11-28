/* =========================================================================
   app.js — 카드뉴스 메이커 UI · 자동 분할 엔진 · PNG/ZIP 내보내기
   ========================================================================= */
(function () {
  'use strict';

  const R = window.CardNewsRender;
  const X = window.CardNewsExtract;          // 주소(URL) → 본문 추출 (extract.js)
  const SAVE_KEY = 'cardnews_maker_v1';

  const state = {
    source: '',
    url: '',                // 마지막으로 불러온 주소
    ratio: '4:5',
    target: 0,              // 0 = 자동, 3 = 3장 요약, 5/6/7 = 전체 장 수
    handle: '@your_id',
    theme: 'dark',
    cards: [],
    view: 'grid',           // grid | slide
    slide: 0,
    photos: []              // 마지막으로 불러온 기사에서 뽑은 사진 주소
  };
  let canvases = [];
  let slideCv = null;
  let saveTimer = null;

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const p2 = (n) => String(n).padStart(2, '0');

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* =====================================================================
     카드 사진 (외부 이미지 · 직접 첨부)
     =====================================================================
     외부 이미지를 canvas 에 그린 뒤 PNG/ZIP 으로 저장하면 그림이 ‘오염된’
     캔버스가 되어 저장이 막힌다(Canvas Taint). 그래서 CORS 를 열어 주는
     이미지 프록시(images.weserv.nl)를 거쳐 crossOrigin 으로 불러온다.
     프록시가 실패하면 그림 없이 원래 테마 배경으로 그린다. */

  const IMG_PROXY = 'https://images.weserv.nl/?url=';
  const IMG_CACHE = new Map();          // 원본 주소 → { el, state }

  function proxied(src) {
    src = String(src || '');
    if (!src) return '';
    if (/^(?:data|blob):/i.test(src)) return src;
    if (!/^https?:\/\//i.test(src)) return '';
    return IMG_PROXY + encodeURIComponent(src.replace(/^https?:\/\//i, '')) + '&w=1080&output=jpg&q=82&we';
  }

  function imageEl(src) {
    const rec = src ? IMG_CACHE.get(src) : null;
    return rec && rec.el ? rec.el : null;
  }

  /** 카드에 걸린 사진을 (필요하면)불러오고, 하나씩 끝날 때마다 다시 그린다 */
  function ensureImages() {
    state.cards.forEach((c, i) => {
      const src = c && c.imageSrc;
      if (!src) return;
      const rec = IMG_CACHE.get(src);
      if (rec) {
        if (rec.state === 'ready' && !rec.painted) { rec.painted = true; if (state.view === 'slide') { if (i === state.slide) renderOne(i); } else renderOne(i); }
        return;
      }
      const entry = { el: null, state: 'loading', painted: false };
      IMG_CACHE.set(src, entry);
      const el = new Image();
      el.crossOrigin = 'anonymous';
      el.decoding = 'async';
      el.onload = () => {
        entry.el = el; entry.state = 'ready'; entry.painted = true;
        if (state.view === 'slide') { if (i === state.slide) renderOne(i); }
        else renderOne(i);
      };
      el.onerror = () => {
        entry.state = 'error';
        if (i === state.slide || state.view !== 'slide') renderOne(i);
      };
      el.src = proxied(src);
      if (!el.src) entry.state = 'error';
    });
  }

  /** 사진 한 장을 카드에 걸기 (직접 첨부·자동 추출 공통) */
  function setCardImage(i, src) {
    const c = state.cards[i];
    if (!c) return;
    if (src) { delete c.imageOff; c.imageSrc = src; }
    else { c.imageSrc = ''; c.imageOff = true; }
    buildEditor();
    buildPreview();
    scheduleSave();
  }

  /** 올린 사진을 카드에 쓰기 좋게 줄이고 dataURL 로 */
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type)) { reject(new Error('image')); return; }
      if (file.size > 20 * 1024 * 1024) { reject(new Error('big')); return; }
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('read'));
      fr.onload = () => {
        const im = new Image();
        im.onerror = () => reject(new Error('image'));
        im.onload = () => {
          const maxW = 1080;
          const sc = Math.min(1, maxW / (im.width || maxW));
          const cv = document.createElement('canvas');
          cv.width = Math.max(1, Math.round((im.width || maxW) * sc));
          cv.height = Math.max(1, Math.round((im.height || maxW) * sc));
          const g = cv.getContext('2d');
          g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, cv.width, cv.height);
          g.drawImage(im, 0, 0, cv.width, cv.height);
          try { resolve(cv.toDataURL('image/jpeg', 0.84)); }
          catch (e) { resolve(String(fr.result)); }
        };
        im.src = String(fr.result);
      };
      fr.readAsDataURL(file);
    });
  }

  /* =====================================================================
     샘플 원문
     ===================================================================== */
  const SAMPLES = [
    {
      key: 'ai',
      label: 'AI 카드뉴스 툴',
      text: `AI가 5분 만에 카드뉴스를 만드는 시대

매일 인스타그램에 올릴 카드뉴스를 만드는 데 2시간씩 쓰는 사람이 많다. 기사 한 편을 읽고, 핵심을 뽑고, 디자인 툴을 열어 장마다 글을 옮겨 붙이는 작업은 생각보다 손이 많이 간다.

이제는 기사 본문을 붙여넣기만 하면 5장에서 7장까지 카드뉴스가 자동으로 나뉜다. 문단의 흐름과 핵심 숫자를 읽어 표지와 요약 카드, 마무리 CTA까지 한 번에 구성한다.

디자인은 5가지 테마로 준비했다. 다크 속보형, 파스텔 매거진형, 네온 숏폼형, 미니멀 화이트형, 경제 신문형이다. 테마를 바꾸면 색상과 폰트, 배지, 레이아웃이 전부 달라진다.

카드뉴스는 인스타그램 4:5 비율과 쇼츠 9:16 비율을 지원한다. 1080×1350 픽셀의 고해상도 PNG로 저장되기 때문에 인스타그램에서 흐릿하게 보이지 않는다.

모든 카드에는 내 인스타그램 아이디가 자동으로 박히고 페이지 번호도 함께 표시된다. 7장을 만드는 데 걸리는 시간은 약 3분, 디자인 외주 비용은 0원이다.

지금 무료로 써보고 매일 카드뉴스 만드는 시간을 줄여보자.`
    },
    {
      key: 'econ',
      label: '경제 뉴스',
      text: `기준금리 동결, 서민 부담은 여전히 제자리

한국은행이 기준금리를 연 2.75%로 동결했다. 시장에서는 3개월 연속 같은 수준을 유지할 것으로 예상했지만, 가계부채 증가세가 변수로 남아 있다.

주택담보대출 변동금리는 이번 결정에 즉시 반영됐다. 시중은행의 주담대 최저금리는 연 3.61%로, 지난달보다 0.12%포인트 내렸다. 5억원을 30년 만기로 빌린 차주는 월 이자로 약 152만원을 부담한다.

전세자금대출도 소폭 조정됐다. 전세보증금 반환보증 금리는 연 2.9% 수준으로, 지난해 4분기보다 0.3%포인트 낮아졌다. 다만 보증료율이 오르면서 실질 부담은 1.4% 줄어드는 데 그쳤다.

전문가들은 하반기 금리 방향을 두고 엇갈린 전망을 내놨다. 한 연구위원은 "물가 상승률이 2.1%로 둔화되면 9월 인하 가능성이 있다"고 말했고, 다른 전문가는 "가계부채가 1,900조원을 넘는 상황에서 섣부른 인하는 어렵다"고 반박했다.

금리 동결이 길어질수록 예금 금리도 떨어진다. 1년 만기 정기예금 평균 금리는 연 3.05%로 1년 전보다 0.4%포인트 하락했다.`
    },
    {
      key: 'marketing',
      label: '마케팅 블로그',
      text: `팔로워 1만 명보다 저장 100회가 중요한 이유

인스타그램 계정을 운영하는 사람들이 가장 먼저 보는 숫자는 팔로워다. 하지만 실제 유입을 만드는 건 저장과 공유다.

저장은 알고리즘에 "나중에 다시 보고 싶은 콘텐츠"라는 신호를 보낸다. 인스타그램은 저장된 게시물을 탐색 탭에 더 오래 노출한다. 실제로 저장 100회를 넘긴 게시물은 평균 도달이 2.4배 높았다.

공유는 팔로워가 아닌 사람에게 닿는다. DM으로 공유된 콘텐츠는 프로필 방문 전환율이 12%까지 올라간다. 반면 좋아요만 받은 콘텐츠의 전환율은 2% 수준이다.

그래서 카드뉴스의 마지막 장이 중요하다. "저장해두세요"라는 한 줄이 들어간 게시물은 그렇지 않은 게시물보다 저장률이 3배 높았다. 마지막 장에 저장 버튼을 그려 넣는 것도 방법이다.

콘텐츠를 만들 때는 한 장에 한 메시지만 담아야 한다. 7장짜리 카드뉴스에서 기억에 남는 건 보통 2장이다. 나머지는 저장과 공유를 부르는 장치라고 생각하면 쉽다.`
    }
  ];

  /* =====================================================================
     자동 분할 엔진
     ===================================================================== */
  const BOILER = /(무단\s*전재|재배포\s*금지|Copyright|ⓒ|©|기자\s*=|제보\s*=|사진\s*=|자료\s*=|구독\s*하기|카카오톡\s*채널|AI\s*요약은|OpenAI의\s*최신\s*기술|기사\s*본문을\s*함께|AI\s*해설은\s*뉴스의|본\s*서비스는\s*AI|투자\s*권유|신고\s*사유\s*선택)/i;
  const NUM_RE = /(\d[\d,]*(?:\.\d+)?\s?(?:%|퍼센트|배|조|억|만|개월|시간|분|초|년|개|명|원|위|대|회|건|달러|포인트|살|세|kg|km|GB|MB|주|일|가지|장|컷|종|곳|단계|배수))/g;

  function normalize(t) {
    return String(t || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function splitSentences(p) {
    const out = [];
    let buf = '';
    for (let i = 0; i < p.length; i++) {
      const ch = p[i];
      buf += ch;
      if (ch === '.' || ch === '!' || ch === '?') {
        const prev = p[i - 1] || '', next = p[i + 1] || '';
        if (/\d/.test(prev) && /\d/.test(next)) { buf += next; i++; continue; }   // 3.5 같은 소수
        if (next === '' || /[\s"'”’)\]】]/.test(next)) {
          let j = i + 1;
          while (j < p.length && /["'”’)\]】]/.test(p[j])) { buf += p[j]; j++; }
          i = j - 1;
          if (buf.trim()) out.push(buf.trim());
          buf = '';
        }
      }
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  /** 너무 긴 문장은 문단 중간에서 한 번 더 끊어 카드에 담기 좋게 만든다 */
  function breakLong(s) {
    if (s.length <= 190) return [s];
    const mid = Math.floor(s.length / 2);
    let cut = -1, best = 1e9;
    for (let i = 60; i < s.length - 60; i++) {
      if (s[i] === ' ' || s[i] === ',' || s[i] === '·') {
        const d = Math.abs(i - mid);
        if (d < best) { best = d; cut = i; }
      }
    }
    if (cut < 0) return [s];
    let a = s.slice(0, cut).trim(), b = s.slice(cut + 1).trim();
    if (a.length < 40 || b.length < 40) return [s];
    if (!/[.!?]$/.test(a)) a += '.';
    return [a, b];
  }

  function clip(s, max) {
    s = String(s || '').trim();
    if (s.length <= max) return s;
    let t = s.slice(0, max);
    const i = Math.max(t.lastIndexOf(' '), t.lastIndexOf(','), t.lastIndexOf('·'));
    if (i > max * 0.55) t = t.slice(0, i);
    return t.replace(/[,\s·]+$/, '') + '…';
  }

  function shortPhrase(s, max) {
    s = String(s || '').replace(/^["'“”‘’\[]+/, '').replace(/^(그러나|하지만|다만|또한|한편|이에|결국|특히|지난|올해|이번)\s+/, '');
    const words = s.split(/\s+/).filter(Boolean);
    let out = '';
    for (const w of words) {
      const cand = (out ? out + ' ' : '') + w;
      if (cand.length > max) break;
      out = cand;
    }
    if (!out) out = words[0] || s;
    return out.replace(/[,.!?·:;]+$/, '');
  }

  function numCandidates(txt) {
    const res = [];
    let m;
    NUM_RE.lastIndex = 0;
    while ((m = NUM_RE.exec(txt))) {
      let score = m[0].length * 0.1;
      if (/%|퍼센트/.test(m[0])) score += 6;
      if (/배|만|억|조/.test(m[0])) score += 4.5;
      if (/원|명|개|건|위|포인트/.test(m[0])) score += 3;
      if (/시간|분|년|개월|초/.test(m[0])) score += 2.6;
      res.push({ v: m[0], index: m.index, score });
    }
    return res;
  }

  function bestNumber(txt) {
    const c = numCandidates(txt);
    if (!c.length) return null;
    return c.sort((a, b) => b.score - a.score)[0];
  }

  function clauseOf(sentence, idx) {
    const re = /[^,·。!?…—:;]+/g;
    let m;
    while ((m = re.exec(sentence))) {
      if (idx >= m.index && idx <= m.index + m[0].length) return m[0].trim();
    }
    return sentence;
  }

  /* 문장 꼬리(조사·연결어)를 다듬어 제목/설명으로 쓸 수 있게 만든다 */
  function cleanPhrase(s, max) {
    s = String(s || '')
      .replace(/^[\s"'“”‘’\[\(【]+/, '')
      .replace(/[\s"'”’\]\)】]+$/, '')
      .replace(/^(그러나|하지만|다만|또한|한편|이에|결국|특히|그런데|그리고|또)\s+/, '')
      .replace(/[.!?…]+$/, '')
      .replace(/[,\s]+$/, '');
    if (s.length > max) {
      const t = s.slice(0, max);
      const i = Math.max(t.lastIndexOf(' '), t.lastIndexOf(','), t.lastIndexOf('·'));
      s = (i > max * 0.5 ? t.slice(0, i) : t).replace(/[,\s·]+$/, '');
    }
    return s.trim();
  }

  /** 숫자 앞뒤 맥락으로 짧은 제목 만들기: "만드는 데 2시간씩" */
  function numPhrase(sentence, num) {
    const before = sentence.slice(0, num.index).trim().split(/\s+/).filter(Boolean);
    let head = [];
    for (let i = before.length - 1; i >= 0 && head.length < 2; i--) {
      let w = before[i].replace(/^[("'“”‘’]+/, '');
      if (head.length === 0) w = w.replace(/(은|는|이|가|을|를|의|에|도|와|과|으로|로)$/, '');  // 마지막 어절의 조사만
      if (!w) continue;
      head.unshift(w);
      if (head.join(' ').length >= 8) break;
    }
    let out = (head.join(' ') + ' ' + num.v).trim();
    const after = sentence.slice(num.index + num.v.length);
    const m = after.match(/^(\s?)(씩|까지|대|이상|미만|가량|정도)/);
    if (m) out += m[2];
    return out.replace(/\s+/g, ' ').trim();
  }

  /** 그룹에서 가장 카드 제목다운 한 줄을 고른다. {title, num} */
  function makeTitle(group) {
    // 1) 숫자가 들어간 절 (가장 정보량이 많은 제목)
    let best = null;
    for (const s of group) {
      const nums = numCandidates(s.t);
      if (!nums.length) continue;
      const n = nums.slice().sort((a, b) => b.score - a.score)[0];
      const raw = clauseOf(s.t, n.index).replace(/[.!?…]+$/, '').trim();
      const c = cleanPhrase(raw, 26);
      if (c.length >= 6 && c.length <= 26 && raw.length <= 27) {
        const sc = (c.length >= 8 && c.length <= 22 ? 3 : 1) + 1 + Math.min(n.score, 6) * 0.3;
        if (!best || sc > best.sc) best = { title: c, sc, num: n };
      }
    }
    if (best) return best;

    // 2) 숫자 주변 맥락
    for (const s of group) {
      const n = numCandidates(s.t)[0];
      if (n) {
        const p = cleanPhrase(numPhrase(s.t, n), 24);
        if (p.length >= 5) return { title: p, num: n };
      }
    }

    // 3) 첫 문장의 첫 절
    const first = group[0].t;
    const comma = first.indexOf(',');
    if (comma > 4 && comma <= 28) {
      const head = cleanPhrase(first.slice(0, comma), 26);
      if (head.length >= 4) return { title: head, num: null };
    }

    // 4) 앞부분 잘라쓰기
    return { title: cleanPhrase(first, 24), num: null };
  }

  /** 숫자 설명은 서술어를 떼어 라벨처럼 */
  function cleanLabel(s) {
    return cleanPhrase(s, 34)
      .replace(/\s*(이다|였다|한다|했다|된다|됐다|입니다|습니다|입니다|이라고|라고)$/, '')
      .replace(/\s*\S*(?:쓰는|하는|있는|없는|위한|대한|따라|통해|관련|비해)$/, '')
      .replace(/[,\s]+$/, '')
      .trim();
  }

  /** 라벨 끝에 숫자가 붙어 있을 때만 숫자를 떼어 명사구로 만든다 */
  function stripNumFromLabel(label, numv) {
    if (!numv || !label.includes(numv)) return label;
    const idx = label.lastIndexOf(numv);
    const tail = label.slice(idx + numv.length).trim();
    if (tail && !/^[.!?…]?$/.test(tail)) return label;   // "연 2.75%로 동결" 같은 경우는 그대로
    let alt = label.slice(0, idx).replace(/[\s,·]+$/, '');
    alt = alt.replace(/(은|는|이|가|을|를|의|에|도|만|과|와|로|으로|씩)$/, '').trim();
    return alt.length >= 4 ? alt : label;
  }

  function ensureSplit(sents, n) {
    const list = sents.slice();
    let guard = 0;
    while (list.length < n && guard++ < 30) {
      let idx = -1, len = 0;
      for (let i = 0; i < list.length; i++) {
        if (list[i].t.length > len && /[,·]/.test(list[i].t)) { idx = i; len = list[i].t.length; }
      }
      if (idx < 0) {
        idx = list.reduce((a, s, i) => (s.t.length > list[a].t.length ? i : a), 0);
        if (list[idx].t.length < 60) break;
      }
      const s = list[idx].t;
      let cut = s.indexOf(','), cut2 = s.indexOf('·');
      if (cut < 0 || (cut2 > 0 && cut2 < cut)) cut = cut2;
      if (cut <= 20 || cut >= s.length - 20) cut = Math.floor(s.length / 2);
      const a = s.slice(0, cut).trim(), b = s.slice(cut + 1).trim();
      if (a.length < 12 || b.length < 12) break;
      list.splice(idx, 1, { t: a + '.', p: list[idx].p }, { t: b, p: list[idx].p });
    }
    return list;
  }

  function splitInto(sents, n) {
    if (n <= 1) return [sents];
    const cum = [0];
    sents.forEach((s, i) => cum.push(cum[i] + s.t.length + 12));
    const total = cum[cum.length - 1];
    const bounds = [0];
    let prev = 0;
    for (let k = 1; k < n; k++) {
      const goal = total * k / n;
      const maxI = sents.length - (n - k);
      let best = null;
      for (let i = prev + 1; i <= maxI; i++) {
        let score = Math.abs(cum[i] - goal);
        if (i < sents.length && sents[i].p !== sents[i - 1].p) score -= 26;   // 문단 경계 선호
        if (!best || score < best.score) best = { i, score };
      }
      const at = best ? best.i : Math.min(prev + 1, sents.length - 1);
      bounds.push(at);
      prev = at;
    }
    bounds.push(sents.length);
    const groups = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const g = sents.slice(bounds[i], bounds[i + 1]);
      if (g.length) groups.push(g);
    }
    while (groups.length < n) groups.push(sents.slice(-1));
    return groups;
  }

  function buildCards(text, target) {
    const norm = normalize(text);
    if (!norm) return [];

    /* 3장 요약 모드는 다른 엔진을 쓴다 */
    if (target === 3) return buildSummaryCards(norm);

    const paras = norm.split(/\n+/).map(s => s.trim()).filter(Boolean);
    let title = '';
    let rest = paras;
    if (paras.length > 1 && paras[0].length <= 70 && !/[.!?]$/.test(paras[0])) {
      title = paras[0];
      rest = paras.slice(1);
    }

    let sents = [];
    rest.forEach((p, pi) => {
      splitSentences(p).forEach(raw => {
        breakLong(raw).forEach(t => {
          t = t.trim();
          if (t.length < 6) return;
          if (BOILER.test(t) && t.length < 90) return;
          sents.push({ t, p: pi });
        });
      });
    });
    if (!sents.length) sents = [{ t: norm, p: 0 }];

    if (!title) {
      title = clip(sents[0].t.replace(/[.!?]$/, ''), 42);
      if (sents.length > 3) sents = sents.slice(1);
    }
    title = title.replace(/[.!?]$/, '').trim();

    const chars = sents.reduce((a, s) => a + s.t.length, 0);
    let n;
    if (target) n = Math.max(3, Math.min(5, target - 2));
    else n = Math.max(3, Math.min(5, Math.round(chars / 150)));
    n = Math.min(n, sents.length);

    sents = ensureSplit(sents, n);
    n = Math.min(n, sents.length);
    const groups = splitInto(sents, n);

    const cards = [];

    /* --- 표지 --- */
    const allNums = [];
    sents.forEach(s => numCandidates(s.t).forEach(n => allNums.push({ n, s })));
    allNums.sort((a, b) => b.n.score - a.n.score);
    const coverNum = allNums.length && allNums[0].n.score >= 3 ? allNums[0] : null;
    const firstSent = sents[0].t;
    const lead = firstSent.length <= 100 ? firstSent : clip(firstSent, 100);
    let coverLabel = coverNum ? cleanLabel(clauseOf(coverNum.s.t, coverNum.n.index)) : '';
    if (coverNum) coverLabel = stripNumFromLabel(coverLabel, coverNum.n.v);
    cards.push({
      type: 'cover',
      badge: '카드뉴스',
      title: clip(title, 52),
      body: lead,
      statNum: coverNum ? coverNum.n.v : '',
      statLabel: coverLabel,
      bullets: []
    });

    /* --- 본문 --- */
    groups.forEach((g, gi) => {
      const joined = g.map(s => s.t).join(' ');
      const scored = g.map(s => {
        const b = bestNumber(s.t);
        let sc = 0;
        if (b) sc += 3 + Math.min(b.score, 6) * 0.5;
        if (s.t.length >= 22 && s.t.length <= 95) sc += 1.4;
        if (s.t.length > 120) sc -= 0.6;
        if (/^(그러나|하지만|또한|다만|한편)/.test(s.t)) sc -= 0.8;
        return { s, sc, b };
      }).sort((a, b) => b.sc - a.sc);
      const key = scored[0];
      const mt = makeTitle(g);
      const title = mt.title;
      const num = mt.num || key.b || bestNumber(joined);

      const rest = g.filter(x => x.t !== key.s.t).map(x => x.t).join(' ');
      const body = rest.length >= 40 ? rest : joined;

      let statLabel = '';
      if (num) {
        statLabel = cleanLabel(clauseOf(key.s.t, num.index));
        if (statLabel.length < 5) statLabel = cleanLabel(key.s.t);
        // 짧은 라벨은 숫자를 빼고 명사구만 남긴다 ("디자인 외주 비용")
        if (statLabel.length <= 26) statLabel = stripNumFromLabel(statLabel, num.v);
        // 제목과 거의 같으면 숫자만 크게 보여준다
        const a = title.replace(/\s/g, ''), b = statLabel.replace(/\s/g, '');
        if (b && (a.includes(b) || b.includes(a))) statLabel = '';
      }

      cards.push({
        type: 'content',
        badge: '핵심 ' + p2(gi + 1),
        title: title,
        body: body,
        statNum: num ? num.v : '',
        statLabel: statLabel,
        bullets: []
      });
    });

    /* --- CTA --- */
    const titles = cards.filter(c => c.type === 'content').map(c => clip(c.title, 30)).filter(Boolean).slice(0, 4);
    cards.push({
      type: 'cta',
      badge: 'SUMMARY',
      title: '이 ' + titles.length + '가지만 기억하세요',
      body: '',
      statNum: '',
      statLabel: '',
      bullets: titles,
      cta: '저장 · 공유 · 팔로우'
    });

    return cards;
  }

  /* =====================================================================
     3장 요약 — 01 표지(제목+대표사진) → 02 핵심 3줄 → 03 결론·CTA
     ===================================================================== */
  function summaryLine(t, max) {
    let s = String(t || '')
      .replace(/^(?:그러나|하지만|다만|또한|한편|이에|결국|특히|그런데|그리고|또|이는|이처럼|아울러)\s+/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[.!?…]+$/, '')
      .replace(/[,·\s]+$/, '');
    if (s.length > max) {
      const cut = s.slice(0, max);
      const sp = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf(','), cut.lastIndexOf('·'));
      s = (sp > max * 0.55 ? cut.slice(0, sp) : cut).replace(/[\s,·]+$/, '') + '…';
    }
    return s;
  }

  function buildSummaryCards(norm) {
    const paras = String(norm).split(/\n+/).map(s => s.trim()).filter(Boolean);
    let title = '';
    let rest = paras;
    if (paras.length > 1 && paras[0].length <= 70 && !/[.!?]$/.test(paras[0])) {
      title = paras[0];
      rest = paras.slice(1);
    }

    let sents = [];
    rest.forEach((p, pi) => {
      splitSentences(p).forEach(raw => {
        breakLong(raw).forEach(t => {
          t = t.trim();
          if (t.length < 6) return;
          if (BOILER.test(t) && t.length < 90) return;
          sents.push({ t, p: pi });
        });
      });
    });
    if (!sents.length) sents = [{ t: norm, p: 0 }];

    if (!title) {
      title = clip(sents[0].t.replace(/[.!?]$/, ''), 46);
      if (sents.length > 3) sents = sents.slice(1);
    }
    title = title.replace(/[.!?]$/, '').trim();

    const scored = sents.map((s, i) => {
      const b = bestNumber(s.t);
      let sc = 0;
      if (b) sc += 3 + Math.min(b.score, 6) * 0.5;
      if (s.t.length >= 24 && s.t.length <= 95) sc += 1.6;
      if (s.t.length > 130) sc -= 0.9;
      if (i === 0) sc += 0.5;
      return { s, i, sc, b };
    });

    const byScore = scored.slice().sort((a, b) => b.sc - a.sc || a.i - b.i);
    const picked = [];
    const usedPara = new Set();
    byScore.forEach(x => {
      if (picked.length >= 3) return;
      if (usedPara.has(x.s.p)) return;
      usedPara.add(x.s.p);
      picked.push(x);
    });
    if (picked.length < 3) {
      byScore.forEach(x => {
        if (picked.length >= 3) return;
        if (picked.some(p => p.i === x.i)) return;
        picked.push(x);
      });
    }
    picked.sort((a, b) => a.i - b.i);
    const lines = picked.map(x => summaryLine(x.s.t, 46)).filter(Boolean);

    /* 표지 — 첫 문장을 리드로, 가장 센 숫자를 크게 */
    const allNums = [];
    sents.forEach(s => numCandidates(s.t).forEach(n => allNums.push({ n, s })));
    allNums.sort((a, b) => b.n.score - a.n.score);
    const coverNum = allNums.length && allNums[0].n.score >= 3 ? allNums[0] : null;
    let coverLabel = coverNum ? cleanLabel(clauseOf(coverNum.s.t, coverNum.n.index)) : '';
    if (coverNum) coverLabel = stripNumFromLabel(coverLabel, coverNum.n.v);

    /* 결론 — 마지막 문단의 핵심 문장 */
    let concl = '';
    const lastP = sents.length ? sents[sents.length - 1] : null;
    if (lastP) concl = summaryLine(lastP.t, 38);
    if (concl.length < 8) {
      const restPick = byScore.find(x => !picked.some(p => p.i === x.i));
      concl = restPick ? summaryLine(restPick.s.t, 38) : summaryLine(title, 38);
    }

    return [
      {
        type: 'cover',
        badge: '카드뉴스',
        title: clip(title, 52),
        body: clip(sents[0].t, 96),
        statNum: coverNum ? coverNum.n.v : '',
        statLabel: coverLabel,
        bullets: []
      },
      {
        type: 'summary',
        badge: '3줄 요약',
        title: '핵심 3가지',
        body: '',
        statNum: '',
        statLabel: '',
        bullets: lines.length ? lines : [summaryLine(title, 46)]
      },
      {
        type: 'cta',
        badge: 'CONCLUSION',
        title: concl || '지금 저장해 두세요',
        body: '자세한 내용은 1장부터 순서대로 보세요.',
        statNum: '',
        statLabel: '',
        bullets: [],
        cta: '저장 · 공유 · 팔로우'
      }
    ];
  }

  /* =====================================================================
     주소(URL)로 본문 불러오기
     ===================================================================== */
  let fetchSeq = 0;

  function setFetchBusy(on) {
    const btn = $('#fetchBtn');
    if (!btn) return;
    btn.disabled = on;
    btn.classList.toggle('busy', on);
    btn.textContent = on ? '불러오는 중' : '불러오기';
  }

  function setNote(html, kind) {
    const el = $('#fetchNote');
    if (!el) return;
    el.innerHTML = html;
    el.className = 'fetch-note' + (kind ? ' ' + kind : '');
  }

  function hideGuide() {
    const g = $('#fetchGuide');
    if (g) g.hidden = true;
  }

  function showGuide(msg) {
    const g = $('#fetchGuide');
    if (!g) return;
    $('#fetchGuideMsg').textContent = msg;
    g.hidden = false;
  }

  function openManual(focus) {
    const w = $('#manualWrap');
    if (w) w.open = true;
    if (focus) { const ta = $('#sourceText'); if (ta) ta.focus(); }
  }

  async function loadFromUrl() {
    const input = $('#urlInput');
    if (!input) return;
    if (!X) {
      setNote('주소 불러오기 기능을 찾지 못했어요. 새로고침해 주세요.', 'bad');
      return;
    }

    const check = X.parseUrl(input.value);
    if (!check.ok) {
      setNote('주소를 확인해 주세요.', 'bad');
      showGuide(X.message(check.error));
      input.focus();
      return;
    }

    hideGuide();
    setFetchBusy(true);
    setNote('본문을 읽는 중이에요… 사이트에 따라 몇 초 걸려요.', 'loading');
    const seq = ++fetchSeq;

    let res;
    try { res = await X.readUrl(check.url); }
    catch (e) { res = { ok: false, error: 'network' }; }
    if (seq !== fetchSeq) return;            // 그사이 다른 주소를 눌렀으면 무시
    setFetchBusy(false);

    if (!res || !res.ok) {
      setNote('자동으로 읽지 못했어요.', 'bad');
      showGuide(X.message((res && res.error) || 'network'));
      return;
    }

    state.url = check.url;
    input.value = check.url;
    const ta = $('#sourceText');
    ta.value = res.text;
    state.source = res.text;
    state.photos = Array.isArray(res.images) ? res.images.slice(0, 3) : [];
    $('#charCount').textContent = res.text.length.toLocaleString() + '자';
    setNote('✅ <b>' + esc(res.host) + '</b> 에서 ' +
      (res.title ? '“' + esc(clipTitleForNote(res.title)) + '” ' : '') +
      res.chars.toLocaleString() + '자를 읽었어요.' +
      (state.photos.length ? ' 본문 사진 ' + state.photos.length + '장도 함께 넣었어요.' : ''), 'good');
    generate(false, true);
  }

  function clipTitleForNote(t) {
    t = String(t || '');
    return t.length > 34 ? t.slice(0, 34).replace(/[\s,·]+$/, '') + '…' : t;
  }

  /* =====================================================================
     렌더
     ===================================================================== */
  function cardLabel(c, i) {
    if (c.type === 'cover') return '표지';
    if (c.type === 'summary') return '요약';
    if (c.type === 'cta') return '마무리';
    return '핵심 ' + p2(i);
  }

  function renderOptions(i) {
    const c = state.cards[i];
    return {
      ratio: state.ratio, theme: state.theme,
      card: c, index: i + 1, total: state.cards.length,
      handle: state.handle,
      photo: imageEl(c && c.imageSrc)
    };
  }

  function renderOne(i) {
    const c = state.cards[i];
    if (!c) return;
    if (state.view === 'slide') {
      if (i === state.slide && slideCv) R.renderCard(slideCv, renderOptions(i));
      return;
    }
    const cv = canvases[i];
    if (cv) R.renderCard(cv, renderOptions(i));
  }

  function renderAll() {
    if (state.view === 'slide') { renderOne(state.slide); return; }
    state.cards.forEach((_, i) => renderOne(i));
  }

  function updateStageMeta() {
    const el = $('#stageMeta');
    if (!el || !state.cards.length) return;
    const d = R.dims(state.ratio);
    el.textContent = state.cards.length + '장 · ' + d.W + '×' + d.H + 'px · ' + R.THEMES[state.theme].name +
      (state.view === 'slide' ? ' · ' + (state.slide + 1) + ' / ' + state.cards.length + ' 넘겨 보는 중' : '');
  }

  function updateViewToggle() {
    const t = $('#viewToggle');
    if (!t) return;
    Array.from(t.querySelectorAll('[data-view]')).forEach(b => b.classList.toggle('on', b.dataset.view === state.view));
    const pos = $('#slidePosMini');
    if (pos) pos.textContent = state.cards.length ? (state.slide + 1) + ' / ' + state.cards.length : '0 / 0';
  }

  function pageSummaryHTML() {
    if (!state.cards.length) return '';
    const rows = state.cards.map((c, i) => {
      const key = (c.bullets && c.bullets.length) ? c.bullets.join(' · ') : (c.body || '');
      return '<li data-slide-to="' + i + '">' +
        '<b>' + p2(i + 1) + '</b>' +
        '<em>' + esc(cardLabel(c, i)) + '</em>' +
        '<span class="ps-t">' + esc(c.title || '') + '</span>' +
        '<span class="ps-l">' + esc(clip(String(key), 64)) + '</span>' +
        '</li>';
    }).join('');
    return '<div class="page-summary">' +
      '<div class="ps-head">한눈에 보는 페이지 요약<button id="slideSummaryBtn" type="button">접기</button></div>' +
      '<ol class="ps-list">' + rows + '</ol></div>';
  }

  function buildGrid() {
    const d = R.dims(state.ratio);
    const host = $('#previewGrid');
    host.className = 'preview-grid';
    host.innerHTML = state.cards.map((c, i) => `
      <figure class="shot" data-i="${i}">
        <div class="shot-frame">
          <canvas></canvas>
          <div class="shot-tools">
            <button class="mini-btn" data-act="zoom" data-i="${i}">크게 보기</button>
            <button class="mini-btn solid" data-act="png" data-i="${i}">PNG</button>
          </div>
        </div>
        <figcaption>
          <span class="cap-i">${p2(i + 1)}</span>
          <span class="cap-t">${esc(cardLabel(c, i))}</span>
          <span class="cap-s">${d.W} × ${d.H}</span>
        </figcaption>
      </figure>`).join('');
    canvases = $$('#previewGrid canvas');
    slideCv = null;
    renderAll();
    ensureImages();
  }

  function buildSlide() {
    const n = state.cards.length;
    const i = Math.max(0, Math.min(n - 1, state.slide));
    state.slide = i;
    const d = R.dims(state.ratio);
    const host = $('#previewGrid');
    host.className = 'preview-grid slide-mode';
    const dots = state.cards.map((_, k) =>
      `<button class="dot${k === i ? ' on' : ''}" data-slide-to="${k}" aria-label="${k + 1}번째 카드"></button>`).join('');
    host.innerHTML = `
      <div class="slide-box">
        <button class="snav prev" data-slide="prev" ${i === 0 ? 'disabled' : ''} aria-label="이전 카드">‹</button>
        <figure class="slide-frame" data-i="${i}">
          <canvas></canvas>
          <span class="slide-badge"><b>${p2(i + 1)}</b> / ${p2(n)}</span>
          <div class="shot-tools">
            <button class="mini-btn" data-act="zoom" data-i="${i}">크게 보기</button>
            <button class="mini-btn solid" data-act="png" data-i="${i}">PNG</button>
          </div>
        </figure>
        <button class="snav next" data-slide="next" ${i === n - 1 ? 'disabled' : ''} aria-label="다음 카드">›</button>
      </div>
      <div class="slide-bar">
        <div class="slide-dots">${dots}</div>
        <div class="slide-info">${esc(cardLabel(state.cards[i], i))} · ${d.W} × ${d.H}</div>
      </div>
      ${pageSummaryHTML()}`;
    slideCv = host.querySelector('canvas');
    canvases = [];
    renderOne(i);
    ensureImages();
    updateViewToggle();
    updateStageMeta();
  }

  function buildPreview() {
    if (!state.cards.length) {
      $('#previewGrid').className = 'preview-grid';
      $('#previewGrid').innerHTML = '<div class="empty"><div class="empty-icon">🔗</div><p>위에 기사·블로그 <b>주소</b>를 넣고 [불러오기]를 누르면<br> 제목·본문을 읽어 표지 + 핵심 카드 + 마무리까지 한 번에 나옵니다.</p></div>';
      canvases = [];
      slideCv = null;
      return;
    }
    if (state.view === 'slide') buildSlide();
    else { buildGrid(); updateViewToggle(); updateStageMeta(); }
  }

  function setView(v) {
    if (v !== 'grid' && v !== 'slide') return;
    state.view = v;
    if (v === 'slide') state.slide = Math.min(state.slide || 0, Math.max(0, state.cards.length - 1));
    buildPreview();
    scheduleSave();
  }

  function goSlide(n) {
    if (!state.cards.length) return;
    const next = Math.max(0, Math.min(state.cards.length - 1, n));
    if (next === state.slide && state.view === 'slide') return;
    state.slide = next;
    if (state.view !== 'slide') state.view = 'slide';
    buildPreview();
  }

  /* =====================================================================
     에디터
     ===================================================================== */
  function editorHTML() {
    if (!state.cards.length) return '<p class="ed-empty">생성된 카드가 없습니다.</p>';
    return state.cards.map((c, i) => `
      <details class="card-item" data-i="${i}" ${i === 0 ? 'open' : ''}>
        <summary>
          <span class="ci-no">${p2(i + 1)}</span>
          <span class="ci-type t-${c.type}">${cardLabel(c, i)}</span>
          <span class="ci-title">${esc(c.title)}</span>
          <span class="ci-chev">⌄</span>
        </summary>
        <div class="ci-body">
          <label class="fld"><span>뱃지</span><input data-card="${i}" data-field="badge" value="${esc(c.badge)}"></label>
          <label class="fld"><span>제목</span><textarea data-card="${i}" data-field="title" rows="2">${esc(c.title)}</textarea></label>
          <label class="fld"><span>본문 / 부제</span><textarea data-card="${i}" data-field="body" rows="3">${esc(c.body)}</textarea></label>
          <div class="two">
            <label class="fld"><span>강조 숫자</span><input data-card="${i}" data-field="statNum" value="${esc(c.statNum || '')}" placeholder="예: 5분"></label>
            <label class="fld"><span>숫자 설명</span><input data-card="${i}" data-field="statLabel" value="${esc(c.statLabel || '')}" placeholder="예: 기사 한 편이 카드로"></label>
          </div>
          ${(c.type === 'cta' || c.type === 'summary') ? `
            <label class="fld"><span>${c.type === 'summary' ? '요약 3줄 (한 줄에 하나)' : '요약 목록 (한 줄에 하나)'}</span><textarea data-card="${i}" data-field="bullets" rows="4">${esc((c.bullets || []).join('\n'))}</textarea></label>` : ''}
          ${c.type === 'cta' ? `
            <label class="fld"><span>CTA 문구</span><input data-card="${i}" data-field="cta" value="${esc(c.cta || '')}"></label>` : ''}
          <div class="ci-photo">
            <div class="ci-photo-thumb">${c.imageSrc
              ? `<img src="${esc(proxied(c.imageSrc))}" alt="카드 사진" loading="lazy">`
              : `<span>사진 없음</span>`}</div>
            <div class="ci-photo-btns">
              <button data-act="pick" data-i="${i}">${c.imageSrc ? '사진 바꾸기' : '사진 넣기'}</button>
              ${c.imageSrc ? `<button data-act="unphoto" data-i="${i}" class="danger">사진 빼기</button>` : ''}
            </div>
          </div>
          <div class="ci-actions">
            <button data-act="up" data-i="${i}" ${i === 0 ? 'disabled' : ''} title="위로">↑</button>
            <button data-act="down" data-i="${i}" ${i === state.cards.length - 1 ? 'disabled' : ''} title="아래로">↓</button>
            <button data-act="dup" data-i="${i}">복제</button>
            <button data-act="del" data-i="${i}" class="danger">삭제</button>
            <button data-act="png" data-i="${i}" class="accent">PNG 저장</button>
          </div>
        </div>
      </details>`).join('');
  }

  function buildEditor() {
    $('#cardEditor').innerHTML = editorHTML();
    $('#cardCountLabel').textContent = state.cards.length ? state.cards.length + '장' : '';
  }

  function updateSummary(i) {
    const el = document.querySelector('.card-item[data-i="' + i + '"] .ci-title');
    if (el && state.cards[i]) el.textContent = state.cards[i].title;
  }

  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight + 2, 260) + 'px';
  }

  /* =====================================================================
     이벤트
     ===================================================================== */
  function bind() {
    if (bind.done) return;      // 두 번 불려도 이벤트가 겹치지 않게
    bind.done = true;
    /* 주소 불러오기 */
    const urlInput = $('#urlInput');
    if (urlInput) {
      urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); loadFromUrl(); }
      });
      urlInput.addEventListener('input', () => { if ($('#fetchGuide') && !$('#fetchGuide').hidden) hideGuide(); });
    }
    const fetchBtn = $('#fetchBtn');
    if (fetchBtn) fetchBtn.addEventListener('click', loadFromUrl);
    const openBtn = $('#openManualBtn');
    if (openBtn) openBtn.addEventListener('click', () => openManual(true));

    /* 원문 */
    const ta = $('#sourceText');
    ta.addEventListener('input', () => {
      state.source = ta.value;
      $('#charCount').textContent = ta.value.length.toLocaleString() + '자';
      scheduleSave();
    });

    $('#sampleRow').addEventListener('click', (e) => {
      const b = e.target.closest('[data-sample]');
      if (!b) return;
      const s = SAMPLES.find(x => x.key === b.dataset.sample) || SAMPLES[0];
      ta.value = s.text;
      state.source = s.text;
      $('#charCount').textContent = s.text.length.toLocaleString() + '자';
      generate(true);
    });

    $('#generateBtn').addEventListener('click', () => generate(false));

    /* 비율 */
    $('#ratioSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-ratio]');
      if (!b) return;
      state.ratio = b.dataset.ratio;
      $$('#ratioSeg button').forEach(x => x.classList.toggle('on', x === b));
      buildPreview(); scheduleSave();
    });

    /* 카드 수 */
    $('#countSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-count]');
      if (!b) return;
      state.target = +b.dataset.count;
      $$('#countSeg button').forEach(x => x.classList.toggle('on', x === b));
      if (state.cards.length) generate(true);
      scheduleSave();
    });

    /* 미리보기 방식 (격자 / 넘겨 보기) */
    const vt = $('#viewToggle');
    if (vt) vt.addEventListener('click', (e) => {
      const b = e.target.closest('[data-view]');
      if (!b) return;
      setView(b.dataset.view);
    });

    /* 사진 파일 선택 */
    const photoInput = $('#photoInput');
    if (photoInput) photoInput.addEventListener('change', async () => {
      const i = +(photoInput.dataset.i || 0);
      const f = photoInput.files && photoInput.files[0];
      photoInput.value = '';
      if (!f) return;
      try {
        const data = await fileToDataUrl(f);
        setCardImage(i, data);
        toast('사진을 넣었어요');
      } catch (err) {
        toast((err && err.message === 'big') ? '사진이 너무 커요 (20MB 이하)' : '사진을 읽지 못했어요');
      }
    });

    /* 아이디 */
    const hi = $('#handleInput');
    hi.addEventListener('input', () => {
      let v = hi.value.trim().replace(/\s+/g, '');
      state.handle = '@' + v.replace(/^@+/, '');
      renderAll(); scheduleSave();
    });

    /* 테마 */
    $('#themeGrid').addEventListener('click', (e) => {
      const b = e.target.closest('[data-theme]');
      if (!b) return;
      state.theme = b.dataset.theme;
      $$('#themeGrid [data-theme]').forEach(x => x.classList.toggle('on', x === b));
      buildPreview(); scheduleSave();
    });

    /* 카드 편집 */
    const ed = $('#cardEditor');
    ed.addEventListener('input', (e) => {
      const el = e.target.closest('[data-field]');
      if (!el) return;
      const i = +el.dataset.card, f = el.dataset.field;
      const c = state.cards[i];
      if (!c) return;
      if (f === 'bullets') c.bullets = el.value.split('\n').map(s => s.trim()).filter(Boolean);
      else c[f] = el.value;
      if (el.tagName === 'TEXTAREA') autoGrow(el);
      if (f === 'title') updateSummary(i);
      renderOne(i);
      scheduleSave();
    });

    ed.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const i = +b.dataset.i;
      const act = b.dataset.act;
      if (act === 'up' && i > 0) { move(i, i - 1); }
      else if (act === 'down' && i < state.cards.length - 1) { move(i, i + 1); }
      else if (act === 'dup') { state.cards.splice(i + 1, 0, JSON.parse(JSON.stringify(state.cards[i]))); buildEditor(); buildPreview(); scheduleSave(); }
      else if (act === 'del') {
        if (state.cards.length <= 1) { toast('카드가 하나뿐이라 삭제할 수 없어요'); return; }
        state.cards.splice(i, 1); buildEditor(); buildPreview(); scheduleSave();
      }
      else if (act === 'png') { downloadCard(i); }
      else if (act === 'pick') {
        const pi = $('#photoInput');
        if (!pi) { toast('사진 기능을 찾지 못했어요. 새로고침해 주세요.'); return; }
        pi.dataset.i = String(i);
        pi.value = '';
        pi.click();
      }
      else if (act === 'unphoto') { setCardImage(i, ''); toast('사진을 뺐어요'); }
    });

    /* 미리보기 */
    $('#previewGrid').addEventListener('click', (e) => {
      const nav = e.target.closest('[data-slide]');
      if (nav) {
        goSlide(nav.dataset.slide === 'prev' ? state.slide - 1 : state.slide + 1);
        return;
      }
      const sumBtn = e.target.closest('#slideSummaryBtn');
      if (sumBtn) {
        const box = sumBtn.closest('.page-summary');
        if (box) {
          box.classList.toggle('off');
          sumBtn.textContent = box.classList.contains('off') ? '펼치기' : '접기';
        }
        return;
      }
      const to = e.target.closest('[data-slide-to]');
      if (to) { goSlide(+to.dataset.slideTo); return; }

      const b = e.target.closest('button[data-act]');
      if (b) {
        const i = +b.dataset.i;
        if (b.dataset.act === 'png') downloadCard(i);
        if (b.dataset.act === 'zoom') openZoom(i);
        return;
      }
      const fig = e.target.closest('.shot, .slide-frame');
      if (fig) openZoom(+fig.dataset.i);
    });

    /* ZIP */
    $('#zipBtn').addEventListener('click', exportZip);

    /* 확대 모달 */
    $('#zoomClose').addEventListener('click', closeZoom);
    $('#zoomModal').addEventListener('click', (e) => { if (e.target.id === 'zoomModal') closeZoom(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeZoom();
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); generate(false); }
      /* 넘겨 보기에서는 좌우 화살표로 카드 넘기기 */
      const tag = (e.target && e.target.tagName) || '';
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable);
      if (typing || state.view !== 'slide') return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); goSlide(state.slide - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goSlide(state.slide + 1); }
    });
  }

  function move(from, to) {
    const c = state.cards.splice(from, 1)[0];
    state.cards.splice(to, 0, c);
    buildEditor(); buildPreview(); scheduleSave();
  }

  /* =====================================================================
     생성
     ===================================================================== */
  function generate(silent, fresh) {
    const src = $('#sourceText').value.trim();
    state.source = src;
    if (!src) { toast('원문을 먼저 붙여넣어 주세요'); return; }
    const btn = $('#generateBtn');
    btn.classList.add('busy');
    btn.disabled = true;
    setTimeout(() => {
      try {
        const prev = fresh ? [] : (state.cards || []);
        const cards = buildCards(src, state.target);
        if (!cards.length) { toast('카드를 만들 수 없어요. 글을 조금 더 넣어주세요'); return; }

        /* 사진 — 직접 넣은 사진은 같은 자리에 유지, 나머지는 기사 사진을 차례로 */
        cards.forEach((c, i) => {
          const old = prev[i];
          if (old && old.imageSrc) { c.imageSrc = old.imageSrc; delete c.imageOff; }
          else if (old && old.imageOff) { c.imageSrc = ''; c.imageOff = true; }
        });
        const photos = state.photos || [];
        cards.forEach((c, i) => {
          if (c.imageSrc || c.imageOff) return;
          const u = photos[i] || (i === 0 ? photos[0] : '');
          if (u) c.imageSrc = u;
        });

        state.cards = cards;
        if (state.view === 'slide') state.slide = Math.min(state.slide, cards.length - 1);
        buildEditor();
        buildPreview();
        if (!silent) {
          const withPhoto = cards.filter(c => c.imageSrc).length;
          toast(cards.length + '장 카드뉴스를 만들었어요' + (withPhoto ? ' (사진 ' + withPhoto + '장)' : '') + ' ✨');
        }
        $('#stageMeta').classList.add('flash');
        setTimeout(() => $('#stageMeta').classList.remove('flash'), 900);
        scheduleSave();
      } catch (err) {
        console.error(err);
        toast('생성 중 문제가 생겼어요: ' + err.message);
      } finally {
        btn.classList.remove('busy');
        btn.disabled = false;
      }
    }, 220);
  }

  /* =====================================================================
     내보내기
     ===================================================================== */
  function stamp() {
    const d = new Date();
    return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '_' + p2(d.getHours()) + p2(d.getMinutes());
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function canvasBlob(cv) {
    return new Promise((res, rej) => {
      try {
        if (cv.toBlob) {
          cv.toBlob(b => (b ? res(b) : rej(new Error('이미지 변환 실패'))), 'image/png');
        } else {
          const d = cv.toDataURL('image/png');
          const bin = atob(d.split(',')[1]);
          const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          res(new Blob([u8], { type: 'image/png' }));
        }
      } catch (err) {
        /* 오염된 캔버스(외부 이미지 CORS 실패) 등 */
        rej(new Error('외부 사진 때문에 저장이 막혔어요. 해당 카드의 사진을 빼고 다시 저장해 주세요'));
      }
    });
  }

  /* 카드 한 장을 임시 캔버스에 그려 PNG Blob 으로 — 화면 상태와 무관하게 저장 */
  function tempCanvas(i) {
    const cv = document.createElement('canvas');
    const d = R.dims(state.ratio);
    cv.width = d.W; cv.height = d.H;
    R.renderCard(cv, renderOptions(i));
    return cv;
  }

  async function downloadCard(i) {
    if (!state.cards[i]) { toast('아직 카드가 없어요'); return; }
    try {
      const blob = await canvasBlob(tempCanvas(i));
      if (!blob) throw new Error('빈 이미지');
      saveBlob(blob, 'cardnews_' + p2(i + 1) + '_' + state.theme + '.png');
      toast(p2(i + 1) + '번 카드 PNG를 저장했어요');
    } catch (err) {
      toast('PNG 저장 실패: ' + (err && err.message ? err.message : '알 수 없는 오류'));
    }
  }

  async function exportZip() {
    if (!state.cards.length) { toast('먼저 카드뉴스를 만들어 주세요'); return; }
    const btn = $('#zipBtn');
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = 'ZIP 만드는 중…';
    try {
      const files = [];
      for (let i = 0; i < state.cards.length; i++) {
        const blob = await canvasBlob(tempCanvas(i));
        if (!blob) throw new Error(p2(i + 1) + '번 카드 이미지를 만들지 못했어요');
        const buf = new Uint8Array(await blob.arrayBuffer());
        files.push({ name: 'cardnews_' + p2(i + 1) + '.png', data: buf });
      }
      const info = [
        '카드뉴스 메이커 — 내보내기 정보',
        '생성 시각: ' + new Date().toLocaleString('ko-KR'),
        '테마: ' + R.THEMES[state.theme].name,
        '비율: ' + state.ratio + ' (' + R.dims(state.ratio).W + 'x' + R.dims(state.ratio).H + ')',
        '아이디: ' + state.handle,
        '카드 수: ' + state.cards.length,
        '사진: ' + state.cards.filter(c => c.imageSrc).length + '장',
        '',
        '파일: cardnews_01.png ~ cardnews_' + p2(state.cards.length) + '.png'
      ].join('\n');
      files.push({ name: 'info.txt', data: new TextEncoder().encode(info) });

      const zip = window.MiniZip.build(files);
      saveBlob(new Blob([zip], { type: 'application/zip' }), 'cardnews_' + stamp() + '.zip');
      toast(state.cards.length + '장 ZIP 저장 완료 (' + (zip.length / 1024 / 1024).toFixed(1) + 'MB)');
    } catch (err) {
      console.error(err);
      toast('ZIP 생성 실패: ' + err.message);
    } finally {
      btn.disabled = false; btn.textContent = old;
    }
  }

  /* =====================================================================
     확대 모달
     ===================================================================== */
  function openZoom(i) {
    const src = canvases[i];
    if (!src) return;
    const m = $('#zoomModal');
    const cv = $('#zoomCanvas');
    cv.width = src.width; cv.height = src.height;
    cv.getContext('2d').drawImage(src, 0, 0);
    m.classList.add('on');
    $('#zoomTitle').textContent = p2(i + 1) + ' / ' + p2(state.cards.length) + ' · ' + cardLabel(state.cards[i], i);
    document.body.style.overflow = 'hidden';
  }
  function closeZoom() {
    $('#zoomModal').classList.remove('on');
    document.body.style.overflow = '';
  }

  /* =====================================================================
     저장 / 복원
     ===================================================================== */
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const payload = {
        source: state.source, url: state.url, ratio: state.ratio, target: state.target,
        handle: state.handle, theme: state.theme, cards: state.cards,
        view: state.view, slide: state.slide, photos: state.photos
      };
      const mark = () => {
        const el = $('#saveState');
        if (el) { el.textContent = '자동 저장됨'; el.classList.add('on'); setTimeout(() => el.classList.remove('on'), 1200); }
      };
      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
        mark();
      } catch (e) {
        /* 사진(dataURL)이 커서 용량을 넘겼을 때 — 사진만 빼고 저장 */
        try {
          payload.cards = state.cards.map(c => (c && /^data:/i.test(c.imageSrc || '')) ? Object.assign({}, c, { imageSrc: '' }) : c);
          localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
          mark();
        } catch (e2) { /* 저장 실패는 무시 */ }
      }
    }, 350);
  }

  function restore() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch (e) { s = null; }
    if (!s || !Array.isArray(s.cards) || !s.cards.length) return false;
    state.source = s.source || '';
    state.url = s.url || '';
    state.ratio = s.ratio || '4:5';
    state.target = typeof s.target === 'number' ? s.target : 0;
    state.handle = s.handle || '@your_id';
    state.theme = s.theme || 'dark';
    state.cards = s.cards;
    state.view = (s.view === 'slide') ? 'slide' : 'grid';
    state.slide = Math.max(0, Math.min(+(s.slide || 0), s.cards.length - 1));
    state.photos = Array.isArray(s.photos) ? s.photos.slice(0, 3) : [];
    return true;
  }

  /* =====================================================================
     초기화
     ===================================================================== */
  function buildThemeGrid() {
    $('#themeGrid').innerHTML = Object.values(R.THEMES).map(t => `
      <button class="theme-card" data-theme="${t.id}" title="${t.name}">
        <span class="mini" style="--m-bg:${t.swatch[0]};--m-ac:${t.swatch[1]};--m-fg:${t.swatch[2]}">
          <i class="m-badge"></i><b class="m-t1"></b><b class="m-t2"></b><s class="m-line"></s><em class="m-stat"></em>
        </span>
        <span class="theme-meta"><strong>${t.short || t.name}</strong><em>${t.tag}</em></span>
      </button>`).join('');
  }

  function syncControls() {
    $$('#ratioSeg button').forEach(b => b.classList.toggle('on', b.dataset.ratio === state.ratio));
    $$('#countSeg button').forEach(b => b.classList.toggle('on', +b.dataset.count === state.target));
    $$('#themeGrid [data-theme]').forEach(b => b.classList.toggle('on', b.dataset.theme === state.theme));
    const hi = $('#handleInput');
    hi.value = state.handle.replace(/^@/, '');
    const ui = $('#urlInput');
    if (ui && state.url) ui.value = state.url;
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('on'), 2200);
  }

  function boot() {
    buildThemeGrid();
    bind();
    const ta = $('#sourceText');

    const ok = restore();
    if (!ok) {
      const s = SAMPLES[0];
      state.source = s.text;
      state.handle = '@your_id';
      ta.value = s.text;
      $('#charCount').textContent = s.text.length.toLocaleString() + '자';
      state.cards = buildCards(s.text, 0);
      setNote('지금 보이는 카드는 <b>예시</b>예요. 위에 기사·블로그 주소를 넣고 <b>불러오기</b>를 누르면 바로 내 기사로 바뀝니다.');
    } else {
      ta.value = state.source;
      $('#charCount').textContent = (state.source || '').length.toLocaleString() + '자';
      if (state.url) {
        setNote('마지막으로 불러온 주소 <b>' + esc(state.url.replace(/^https?:\/\//, '').slice(0, 40)) + '</b> 의 카드예요.');
      }
    }
    syncControls();
    buildEditor();
    buildPreview();
    $$('#cardEditor textarea').forEach(autoGrow);

    // 디버그/테스트용
    window.CardNewsApp = {
      state, generate, buildCards, buildSummaryCards, renderAll, exportZip, downloadCard, loadFromUrl,
      setTheme(t) { state.theme = t; syncControls(); buildPreview(); },
      setRatio(r) { state.ratio = r; syncControls(); buildPreview(); },
      setView,
      goSlide,
      setCardImage,
      proxied,
      imageEl,
      tempCanvas,
      getCanvases() { return canvases; },
      getSlideCanvas() { return slideCv; }
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
