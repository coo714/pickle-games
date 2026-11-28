/* =========================================================================
   render.js — 카드뉴스 캔버스 렌더 엔진
   1080x1350 (4:5) / 1080x1920 (9:16) 실해상도 렌더. 미리보기와 PNG 저장이
   완전히 같은 코드로 그려지므로 화면 = 결과물.
   ========================================================================= */
(function (global) {
  'use strict';

  /* ---------- fonts -------------------------------------------------- */
  const SANS = '"Pretendard","Apple SD Gothic Neo","Noto Sans KR","Noto Sans CJK KR","Malgun Gothic","Helvetica Neue",Arial,sans-serif';
  const SERIF = '"Noto Serif CJK KR","Nanum Myeongjo","AppleMyungjo","Batang","Times New Roman",serif';

  /* ---------- tiny utils --------------------------------------------- */
  function fx(w, s, fam) { return w + ' ' + Math.round(s) + 'px ' + fam; }
  function p2(n) { return String(n).padStart(2, '0'); }

  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function spaced(ctx, text, x, y, sp, align) {
    const prev = ctx.textAlign; ctx.textAlign = 'left';
    const chars = Array.from(String(text));
    let w = 0;
    for (const c of chars) w += ctx.measureText(c).width + sp;
    w = Math.max(0, w - sp);
    let cx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    for (const c of chars) { ctx.fillText(c, cx, y); cx += ctx.measureText(c).width + sp; }
    ctx.textAlign = prev;
    return w;
  }

  function measureSpaced(ctx, text, sp) {
    const chars = Array.from(String(text));
    let w = 0; for (const c of chars) w += ctx.measureText(c).width + sp;
    return Math.max(0, w - sp);
  }

  function dateKo() {
    const d = new Date();
    const days = ['일', '월', '화', '수', '목', '금', '토'];
    return d.getFullYear() + '.' + p2(d.getMonth() + 1) + '.' + p2(d.getDate()) + ' (' + days[d.getDay()] + ')';
  }

  function hexA(hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* ---------- 사진 (카드 배경용) --------------------------------------- */
  function imgSize(img) {
    if (!img) return null;
    const w = img.width || img.naturalWidth || 0;
    const h = img.height || img.naturalHeight || 0;
    return w && h ? { w, h } : null;
  }

  /** 사진을 영역에 꽉 차게(cover) 잘라 그린다 */
  function drawCoverCrop(ctx, img, x, y, w, h, focus) {
    const s = imgSize(img);
    if (!s) return false;
    const sc = Math.max(w / s.w, h / s.h);
    const sw = w / sc, sh = h / sc;
    const sx = (s.w - sw) / 2;
    const sy = Math.max(0, Math.min(s.h - sh, (s.h - sh) * (focus == null ? 0.4 : focus)));
    ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
    return true;
  }

  /**
   * 사진 띠 — 카드 위쪽에 사진을 깔고 아래쪽을 테마 배경색으로 부드럽게 넘긴다.
   * 위쪽에는 같은 색 워시를 엷게 깔아 머리말·배지 글자가 묻히지 않게 한다.
   * 그린 높이를 돌려준다 (사진이 없으면 0).
   */
  function photoBand(ctx, img, W, top, h, cfg) {
    cfg = cfg || {};
    if (!imgSize(img)) return 0;
    const y = Math.max(0, top), hh = Math.max(40, h);
    const fade = cfg.fade || '#000000';
    const wash = cfg.wash || fade;

    ctx.save();
    ctx.beginPath(); ctx.rect(0, y, W, hh); ctx.clip();
    drawCoverCrop(ctx, img, 0, y, W, hh, cfg.focus);

    // 전체 톤 정리
    if (cfg.tintA) { ctx.fillStyle = hexA(cfg.tint || '#000000', cfg.tintA); ctx.fillRect(0, y, W, hh); }

    // 위쪽 워시 (머리말이 사진 위에 올 때)
    const washA = cfg.washA == null ? 0.55 : cfg.washA;
    if (washA > 0) {
      const g1 = ctx.createLinearGradient(0, y, 0, y + hh * 0.52);
      g1.addColorStop(0, hexA(wash, washA));
      g1.addColorStop(1, hexA(wash, 0));
      ctx.fillStyle = g1; ctx.fillRect(0, y, W, hh * 0.52);
    }

    // 아래쪽 → 테마 배경색
    const f = cfg.fadeFrom == null ? 0.52 : cfg.fadeFrom;
    const g2 = ctx.createLinearGradient(0, y + hh * f, 0, y + hh);
    g2.addColorStop(0, hexA(fade, 0));
    g2.addColorStop(1, hexA(fade, 1));
    ctx.fillStyle = g2; ctx.fillRect(0, y + hh * f, W, hh * (1 - f));
    ctx.restore();
    return hh;
  }

  /** 사진 위에 강조 숫자 + 설명 (아래쪽 스크림 위) */
  function statOnPhoto(ctx, card, o) {
    if (!card.statNum) return false;
    const W = o.W, pad = o.pad;
    const base = o.base;
    const g = ctx.createLinearGradient(0, base - 215, 0, base + 62);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.5, 'rgba(0,0,0,0.40)');
    g.addColorStop(1, 'rgba(0,0,0,0.74)');
    ctx.fillStyle = g; ctx.fillRect(0, base - 215, W, 282);

    const size = fitOneLine(ctx, card.statNum, { size: o.size || 100, min: 44, weight: 900, fam: o.fam, maxW: W - pad * 2 });
    ctx.font = fx(900, size, o.fam || SANS);
    ctx.fillStyle = o.color || '#FFFFFF';
    ctx.textAlign = 'left';
    ctx.fillText(card.statNum, pad, base);
    if (card.statLabel) {
      const l = layoutRich(ctx, card.statLabel, { maxW: W - pad * 2, maxLines: 1, sizeMax: 25, sizeMin: 17, weight: 600, lh: 1.4, fam: SANS });
      drawRich(ctx, l, pad, base + 32, { color: 'rgba(255,255,255,0.92)' });
    }
    return true;
  }

  /* ---------- rich text (숫자 강조 + 한글 어절 단위 줄바꿈) ------------- */
  // 단위가 붙은 숫자만 강조 (2026.11 같은 날짜는 % 없이도 잡히지만 무해)
  const NUM_RE = /(\d[\d,]*(?:\.\d+)?\s?(?:%|퍼센트|배|조|억|만|개월|시간|분|초|년|개|명|원|위|대|회|건|달러|포인트|살|세|kg|km|GB|MB|주|일|가지|장|컷|종|곳|단계|배수))/g;

  /** 문장을 어절(word) 배열로. 각 어절은 스타일 조각(parts)들의 묶음. */
  function richWords(text) {
    const s = String(text == null ? '' : text).replace(/\r/g, '');
    const raw = s.split(/\s+/).filter(Boolean);
    return raw.map(word => {
      const parts = [];
      let last = 0, m;
      NUM_RE.lastIndex = 0;
      while ((m = NUM_RE.exec(word))) {
        if (m.index > last) parts.push({ t: word.slice(last, m.index), s: '' });
        parts.push({ t: m[0], s: 'n' });
        last = m.index + m[0].length;
      }
      if (last < word.length) parts.push({ t: word.slice(last), s: '' });
      return parts;
    });
  }

  /** 어절 단위 줄바꽈. 한 어절이 폭보다 길 때만 글자 단위로 쪼갠다. */
  function wrapWords(ctx, words, maxW) {
    const lines = [];
    let cur = { w: 0, segs: [] };
    const sp = ctx.measureText(' ').width;
    for (const parts of words) {
      let ww = 0;
      for (const p of parts) ww += ctx.measureText(p.t).width;

      if (cur.segs.length) {
        if (cur.w + sp + ww <= maxW) { cur.segs.push({ t: ' ', s: '' }); cur.w += sp; }
        else { lines.push(cur); cur = { w: 0, segs: [] }; }
      }

      if (ww > maxW) {
        for (const p of parts) {
          for (const ch of Array.from(p.t)) {
            const cw = ctx.measureText(ch).width;
            if (cur.w + cw > maxW && cur.segs.length) { lines.push(cur); cur = { w: 0, segs: [] }; }
            cur.segs.push({ t: ch, s: p.s }); cur.w += cw;
          }
        }
      } else {
        for (const p of parts) cur.segs.push(p);
        cur.w += ww;
      }
    }
    if (cur.segs.length) lines.push(cur);
    return lines;
  }

  function trimLine(ctx, line, maxW) {
    // 끝에 … 붙이기 — 낱말 중간에서 자르지 않고 마지막 온전한 어절까지만 남긴다
    let segs = line.segs.slice();
    const ell = '…';
    const ew = ctx.measureText(ell).width;
    let w = line.w;
    while (segs.length && w + ew > maxW) {
      const last = segs[segs.length - 1];
      if (last.t.length > 1) {
        const t = last.t.slice(0, -1);
        w -= ctx.measureText(last.t).width - ctx.measureText(t).width;
        segs[segs.length - 1] = { t, s: last.s };
      } else {
        w -= ctx.measureText(last.t).width;
        segs.pop();
      }
    }
    // 어절 중간에서 잘렸으면 그 어절을 통째로 버린다
    if (segs.length > 1 && line.w + ew > maxW) {
      let cut = -1;
      for (let i = segs.length - 1; i >= 0; i--) { if (segs[i].t === ' ') { cut = i; break; } }
      if (cut > 0) {
        let nw = 0;
        for (let i = 0; i < cut; i++) nw += ctx.measureText(segs[i].t).width;
        if (nw > maxW * 0.45) { segs = segs.slice(0, cut); w = nw; }
      }
    }
    while (segs.length && segs[segs.length - 1].t === ' ') { w -= ctx.measureText(' ').width; segs.pop(); }
    if (!segs.length) segs = [{ t: ell, s: '' }]; else segs.push({ t: ell, s: segs[segs.length - 1].s });
    return { w: w + ew, segs };
  }

  /* opts: maxW, maxLines, sizeMax, sizeMin, weight, fam, lh, align */
  function layoutRich(ctx, text, o) {
    const maxW = o.maxW, maxLines = Math.max(1, o.maxLines | 0 || 1);
    const sizeMax = o.sizeMax, sizeMin = Math.min(o.sizeMin || 20, sizeMax);
    const words = richWords(text);
    let size = sizeMax, lines = [], lh = 0;
    for (;;) {
      ctx.font = fx(o.weight || 400, size, o.fam || SANS);
      lines = words.length ? wrapWords(ctx, words, maxW) : [];
      lh = size * (o.lh || 1.3);
      if (lines.length <= maxLines) break;
      if (size <= sizeMin) {
        lines = lines.slice(0, maxLines);
        if (lines.length) lines[lines.length - 1] = trimLine(ctx, lines[lines.length - 1], maxW);
        break;
      }
      size -= Math.max(1, Math.round(size * 0.035));
      if (size < sizeMin) size = sizeMin;
    }
    if (!words.length) { ctx.font = fx(o.weight || 400, size, o.fam || SANS); lines = []; }
    return { size, lines, lh, height: lines.length * lh, maxW, weight: o.weight, fam: o.fam, clipped: lines.length >= maxLines };
  }

  function drawRich(ctx, lay, x, y, o) {
    o = o || {};
    ctx.font = fx(lay.weight || o.weight || 400, lay.size, lay.fam || o.fam || SANS);
    ctx.textAlign = 'left';
    let yy = y;
    for (const line of lay.lines) {
      let cx = o.align === 'center' ? x - line.w / 2 : o.align === 'right' ? x - line.w : x;
      for (const seg of line.segs) {
        ctx.fillStyle = (seg.s === 'n' && o.numColor) ? o.numColor : (o.grad || o.color || '#000');
        ctx.fillText(seg.t, cx, yy);
        cx += ctx.measureText(seg.t).width;
      }
      yy += lay.lh;
    }
    return lay.height;
  }

  function fitOneLine(ctx, text, o) {
    let s = o.size;
    ctx.font = fx(o.weight || 700, s, o.fam || SANS);
    while (s > (o.min || 20) && ctx.measureText(text).width > o.maxW) {
      s -= Math.max(1, Math.round(s * 0.04)); ctx.font = fx(o.weight || 700, s, o.fam || SANS);
    }
    return s;
  }

  /* 불릿을 주어진 세로 영역에 고르게 분배해 그린다 (CTA 카드용) */
  function drawBulletsSpread(ctx, lay, x, top, bottom, o) {
    const n = lay.items.length;
    if (!n) return 0;
    const lh = o.size * (o.lh || 1.5);
    const heights = lay.items.map(lines => lines.length * lh);
    const total = heights.reduce((a, b) => a + b, 0);
    const band = Math.max(total, bottom - top);
    let gap = n > 1 ? (band - total) / (n - 1) : 0;
    gap = Math.max(o.gap || 12, Math.min(gap, o.maxGap || 120));
    const used = total + gap * (n - 1);
    let yy = top + Math.max(0, (band - used) / 2);
    ctx.font = fx(o.weight || 500, o.size, o.fam || SANS);
    lay.items.forEach((lines, i) => {
      if (i) yy += gap;
      lines.forEach((line, li) => {
        if (li === 0 && o.glyph) {
          ctx.fillStyle = o.glyphColor || o.color;
          ctx.font = fx(o.glyphWeight || 700, o.glyphSize || o.size * 0.9, o.glyphFam || o.fam || SANS);
          if (o.glyphDraw) o.glyphDraw(ctx, x, yy, i); else ctx.fillText(o.glyph, x, yy);
          ctx.font = fx(o.weight || 500, o.size, o.fam || SANS);
        }
        let cx = x + o.indent;
        for (const seg of line.segs) {
          ctx.fillStyle = seg.s === 'n' && o.numColor ? o.numColor : o.color;
          ctx.fillText(seg.t, cx, yy);
          cx += ctx.measureText(seg.t).width;
        }
        yy += lh;
      });
    });
    return yy - top;
  }

  /* 불릿 목록 */
  function layoutBullets(ctx, items, o) {
    ctx.font = fx(o.weight || 500, o.size, o.fam || SANS);
    const inner = o.maxW - o.indent;
    const res = [];
    for (const it of items) {
      const lines = wrapWords(ctx, richWords(it), inner);
      res.push(lines);
    }
    let h = 0;
    res.forEach((lines, i) => { h += lines.length * o.size * (o.lh || 1.5) + (i ? (o.gap || 18) : 0); });
    return { items: res, height: h };
  }

  function drawBullets(ctx, lay, x, y, o) {
    ctx.font = fx(o.weight || 500, o.size, o.fam || SANS);
    ctx.textAlign = 'left';
    let yy = y;
    lay.items.forEach((lines, i) => {
      if (i && o.gap) yy += o.gap;
      const lh = o.size * (o.lh || 1.5);
      lines.forEach((line, li) => {
        if (li === 0 && o.glyph) {
          ctx.fillStyle = o.glyphColor || o.color;
          ctx.font = fx(o.glyphWeight || 700, o.glyphSize || o.size * 0.9, o.glyphFam || o.fam || SANS);
          if (o.glyphDraw) o.glyphDraw(ctx, x, yy, i); else ctx.fillText(o.glyph, x, yy);
          ctx.font = fx(o.weight || 500, o.size, o.fam || SANS);
        }
        let cx = x + o.indent;
        for (const seg of line.segs) {
          ctx.fillStyle = seg.s === 'n' && o.numColor ? o.numColor : o.color;
          ctx.fillText(seg.t, cx, yy);
          cx += ctx.measureText(seg.t).width;
        }
        yy += lh;
      });
    });
    return lay.height;
  }

  /* 도형/장식 */
  function hatch(ctx, x, y, w, h, color, step, lw) {
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.strokeStyle = color; ctx.lineWidth = lw || 1;
    for (let i = -h; i < w; i += step) {
      ctx.beginPath(); ctx.moveTo(x + i, y + h); ctx.lineTo(x + i + h, y); ctx.stroke();
    }
    ctx.restore();
  }

  function noise(ctx, W, H, alpha, n) {
    ctx.save(); ctx.fillStyle = 'rgba(255,255,255,' + alpha + ')';
    let seed = 1337;
    for (let i = 0; i < (n || 700); i++) {
      seed = (seed * 9301 + 49297) % 233280;
      const x = (seed / 233280) * W;
      seed = (seed * 9301 + 49297) % 233280;
      const y = (seed / 233280) * H;
      ctx.fillRect(x, y, 2, 2);
    }
    ctx.restore();
  }

  /* =====================================================================
     THEME 1 — 다크 속보형
     ===================================================================== */
  const C1 = { bg: '#0A0A0E', red: '#FF2D2D', white: '#FFFFFF', sub: '#A9A9B6', dim: 'rgba(255,255,255,0.45)', num: '#FF6B6B' };

  function d1Bg(ctx, W, H) {
    const g = ctx.createLinearGradient(0, 0, W * 0.7, H);
    g.addColorStop(0, '#17171F'); g.addColorStop(0.5, '#0B0B10'); g.addColorStop(1, '#050508');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const rg = ctx.createRadialGradient(W * 0.12, H * 0.04, 0, W * 0.12, H * 0.04, W);
    rg.addColorStop(0, 'rgba(255,45,45,0.22)'); rg.addColorStop(0.55, 'rgba(255,45,45,0.05)'); rg.addColorStop(1, 'rgba(255,45,45,0)');
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.globalAlpha = 0.07; ctx.strokeStyle = C1.red; ctx.lineWidth = 20;
    for (let i = 0; i < 8; i++) {
      ctx.beginPath(); ctx.moveTo(W - 300 + i * 42, H); ctx.lineTo(W + 40 + i * 42, H - 300); ctx.stroke();
    }
    ctx.restore();
    noise(ctx, W, H, 0.03, 600);
  }

  function d1Mast(ctx, W, pad) {
    ctx.fillStyle = C1.red; ctx.fillRect(pad, 64, 18, 18);
    ctx.fillStyle = C1.white; ctx.font = fx(800, 26, SANS); ctx.textBaseline = 'alphabetic';
    spaced(ctx, 'BREAKING NEWS', pad + 34, 82, 3.4);
    ctx.font = fx(500, 22, SANS); ctx.fillStyle = C1.dim;
    ctx.textAlign = 'right'; ctx.fillText(dateKo(), W - pad, 82); ctx.textAlign = 'left';
    ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(pad, 120); ctx.lineTo(W - pad, 120); ctx.stroke();
  }

  function d1Foot(ctx, W, H, handle, idx, total) {
    const pad = 84;
    ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(pad, H - 118); ctx.lineTo(W - pad, H - 118); ctx.stroke();
    ctx.font = fx(600, 25, SANS); ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(handle, pad, H - 70);
    ctx.textAlign = 'right'; ctx.font = fx(800, 26, SANS); ctx.fillStyle = C1.red;
    spaced(ctx, p2(idx) + ' / ' + p2(total), W - pad, H - 70, 1, 'right');
    ctx.textAlign = 'left';
  }

  function d1Badge(ctx, x, y, text, outline) {
    ctx.font = fx(800, 26, SANS);
    const tw = measureSpaced(ctx, text, 2.4);
    const w = tw + 52, h = 56;
    if (outline) {
      ctx.strokeStyle = C1.red; ctx.lineWidth = 2;
      rr(ctx, x, y, w, h, 4); ctx.stroke();
      ctx.fillStyle = C1.red;
    } else {
      ctx.fillStyle = C1.red; rr(ctx, x, y, w, h, 4); ctx.fill();
      ctx.fillStyle = '#FFFFFF';
    }
    spaced(ctx, text, x + 26, y + 37, 2.4);
    return w;
  }

  function d1Stat(ctx, W, H, card, x, numBaseline, labelBaseline) {
    const pad = 84;
    ctx.fillStyle = C1.red; ctx.fillRect(pad, numBaseline - 128, 76, 8);
    const s = fitOneLine(ctx, card.statNum, { size: 132, min: 64, weight: 900, maxW: W - pad * 2 });
    ctx.font = fx(900, s, SANS); ctx.fillStyle = C1.red; ctx.fillText(card.statNum, pad, numBaseline);
    if (card.statLabel) {
      ctx.font = fx(600, 29, SANS); ctx.fillStyle = C1.sub;
      const l = layoutRich(ctx, card.statLabel, { maxW: W - pad * 2, maxLines: 2, sizeMax: 29, sizeMin: 21, weight: 600, lh: 1.45 });
      drawRich(ctx, l, pad, labelBaseline, { color: C1.sub, numColor: C1.white });
    }
  }

  function drawDark(ctx, o) {
    const { W, H, card, index, total, handle } = o;
    const pad = 84, tall = H > 1500;
    d1Bg(ctx, W, H);
    d1Mast(ctx, W, pad);

    if (card.type === 'cover') {
      /* 사진이 있으면 머리말 아래를 사진으로 채우고 글자를 그 아래로 내린다 */
      const bh = photoBand(ctx, o.photo, W, 140, tall ? 620 : 360, { fade: C1.bg, tintA: 0.10, washA: 0.66 });
      const bandBottom = bh ? 140 + bh : 0;

      const badgeTxt = card.badge || '카드뉴스';
      d1Badge(ctx, pad, 176, badgeTxt, false);

      const titleTop = bh ? bandBottom + 74 : (tall ? 320 : 286);
      const lay = layoutRich(ctx, card.title, { maxW: W - pad * 2, maxLines: bh ? (tall ? 4 : 3) : (tall ? 5 : 4), sizeMax: tall ? 118 : 108, sizeMin: 54, weight: 900, lh: 1.13 });
      drawRich(ctx, lay, pad, titleTop + lay.size * 0.92, { color: C1.white, numColor: C1.num });

      let cursor = titleTop + lay.height + 52;
      if (card.body) {
        const avail = (card.statNum && !bh ? H - 392 - 26 : H - 210) - cursor;
        const maxLines = Math.max(1, Math.min(tall ? 5 : 4, Math.floor(avail / 58)));
        const sub = layoutRich(ctx, card.body, { maxW: W - pad * 2 - 30, maxLines, sizeMax: 35, sizeMin: 24, weight: 500, lh: 1.62 });
        drawRich(ctx, sub, pad, cursor + sub.size, { color: C1.sub, numColor: C1.num });
      }
      if (card.statNum && bh) statOnPhoto(ctx, card, { W, pad, base: bandBottom - 96, color: C1.red, size: 96 });
      else if (card.statNum) d1Stat(ctx, W, H, card, pad, H - 300, H - 236);
      else if (!bh) {
        ctx.font = fx(700, 23, SANS); ctx.fillStyle = C1.dim;
        spaced(ctx, '옆으로 넘겨보세요', pad, H - 214, 1.2);
        ctx.fillStyle = C1.red; ctx.fillText('→', pad + 210, H - 214);
      }
      d1Foot(ctx, W, H, handle, index, total);
      return;
    }

    if (card.type === 'content') {
      const bh = photoBand(ctx, o.photo, W, 132, tall ? 520 : 326, { fade: C1.bg, tintA: 0.10, washA: 0.62 });
      const bandBottom = bh ? 132 + bh : 0;

      d1Badge(ctx, pad, 150, card.badge || ('핵심 ' + p2(index)), true);
      if (!bh) {
        ctx.save();
        ctx.textAlign = 'right'; ctx.font = fx(900, 300, SANS);
        ctx.fillStyle = 'rgba(255,255,255,0.045)';
        ctx.fillText(p2(index), W - pad + 12, 420);
        ctx.restore();
      }

      const titleTop = bh ? bandBottom + 50 : (tall ? 340 : 316);
      const lay = layoutRich(ctx, card.title, { maxW: W - pad * 2, maxLines: 3, sizeMax: tall ? 104 : 84, sizeMin: 46, weight: 900, lh: 1.16 });
      ctx.fillStyle = C1.red; ctx.fillRect(pad, titleTop - 32, 72, 8);
      drawRich(ctx, lay, pad, titleTop + lay.size * 0.9, { color: C1.white, numColor: C1.num });

      const bodyTop = titleTop + lay.height + 54;
      const bottom = card.statNum && !bh ? H - 420 : H - 210;
      const bodySize = tall ? 40 : 34;
      const maxLines = Math.max(1, Math.floor((bottom - bodyTop) / (bodySize * 1.72)));
      const body = layoutRich(ctx, card.body, { maxW: W - pad * 2, maxLines, sizeMax: bodySize, sizeMin: 19, weight: 500, lh: 1.72 });
      drawRich(ctx, body, pad, bodyTop + body.size, { color: C1.sub, numColor: C1.num });


      if (card.statNum) {
        if (bh) statOnPhoto(ctx, card, { W, pad, base: bandBottom - 72, color: C1.red, size: 96 });
        else {
          const nb = Math.min(H - 262, bodyTop + body.height + 210);
          ctx.strokeStyle = 'rgba(255,255,255,0.13)'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(pad, nb - 110); ctx.lineTo(W - pad, nb - 110); ctx.stroke();
          d1Stat(ctx, W, H, card, pad, nb, nb + 64);
        }
      }
      d1Foot(ctx, W, H, handle, index, total);
      return;
    }

    /* CTA */
    const px = 64, py = 176, pw = W - px * 2, ph = H - py - 190;
    ctx.fillStyle = C1.red; rr(ctx, px, py, pw, ph, 26); ctx.fill();
    hatch(ctx, px, py, pw, ph, 'rgba(0,0,0,0.06)', 26, 10);

    const ip = px + 68, iw = pw - 136;
    ctx.font = fx(800, 24, SANS); ctx.fillStyle = 'rgba(10,10,14,0.55)';
    spaced(ctx, card.badge || 'SUMMARY', ip, py + 92, 3.4);

    const lay = layoutRich(ctx, card.title, { maxW: iw, maxLines: 3, sizeMax: 82, sizeMin: 46, weight: 900, lh: 1.16 });
    drawRich(ctx, lay, ip, py + 186, { color: '#0B0B0F' });

    let by = py + 186 + lay.height + 34;
    const items = (card.bullets || []).slice(0, 4);
    const ctaBarTop = py + ph - 118;
    if (items.length) {
      const bl = layoutBullets(ctx, items, { maxW: iw, indent: 40, size: 32, weight: 700, lh: 1.5, gap: 16 });
      drawBulletsSpread(ctx, bl, ip, by + 10, ctaBarTop - 60, {
        color: 'rgba(11,11,15,0.9)', numColor: '#0B0B0F', size: 32, weight: 700, lh: 1.5, indent: 40, maxGap: 118,
        glyph: '—', glyphColor: 'rgba(11,11,15,0.45)', glyphSize: 26
      });
    }
    if (card.body) {
      const sub = layoutRich(ctx, card.body, { maxW: iw, maxLines: 2, sizeMax: 26, sizeMin: 18, weight: 600, lh: 1.6 });
      drawRich(ctx, sub, ip, ctaBarTop - 60, { color: 'rgba(11,11,15,0.62)' });
    }
    const cy = ctaBarTop;
    // 깊이를 위한 큰 워터마크 숫자
    ctx.save();
    ctx.textAlign = 'right'; ctx.font = fx(900, 380, SANS);
    ctx.fillStyle = 'rgba(0,0,0,0.055)';
    ctx.fillText(p2(index), px + pw - 44, py + ph - 150);
    ctx.restore();
    ctx.fillStyle = '#0B0B0F'; rr(ctx, ip, cy, iw, 78, 8); ctx.fill();
    ctx.fillStyle = '#FFFFFF'; ctx.font = fx(800, 29, SANS); ctx.textAlign = 'center';
    spaced(ctx, card.cta || '저장 · 공유 · 팔로우', ip + iw / 2, cy + 49, 1.6, 'center');
    ctx.textAlign = 'left';

    d1Foot(ctx, W, H, handle, index, total);
  }

  /* =====================================================================
     THEME 2 — 파스텔 매거진형
     ===================================================================== */
  const C2 = { bg: '#FBF3EE', accent: '#D07E68', deep: '#3B2A2C', sub: '#7A6668', frame: '#E4C3B8', num: '#C4694F' };

  function d2Bg(ctx, W, H) {
    ctx.fillStyle = C2.bg; ctx.fillRect(0, 0, W, H);
    const g1 = ctx.createRadialGradient(W * 0.9, H * 0.06, 0, W * 0.9, H * 0.06, W * 0.55);
    g1.addColorStop(0, 'rgba(246,205,188,0.85)'); g1.addColorStop(1, 'rgba(246,205,188,0)');
    ctx.fillStyle = g1; ctx.fillRect(0, 0, W, H);
    const g2 = ctx.createRadialGradient(W * 0.05, H * 0.92, 0, W * 0.05, H * 0.92, W * 0.5);
    g2.addColorStop(0, 'rgba(226,214,240,0.7)'); g2.addColorStop(1, 'rgba(226,214,240,0)');
    ctx.fillStyle = g2; ctx.fillRect(0, 0, W, H);
    // 도트 패턴
    ctx.fillStyle = 'rgba(208,126,104,0.10)';
    for (let y = 40; y < H; y += 44) for (let x = 40; x < W; x += 44) {
      ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill();
    }
  }

  function d2Frame(ctx, W, H) {
    const i = 48;
    ctx.strokeStyle = C2.frame; ctx.lineWidth = 1.6;
    ctx.strokeRect(i, i, W - i * 2, H - i * 2);
    ctx.strokeStyle = 'rgba(208,126,104,0.35)'; ctx.lineWidth = 1;
    ctx.strokeRect(i + 8, i + 8, W - (i + 8) * 2, H - (i + 8) * 2);
  }

  function d2Foot(ctx, W, H, handle, idx, total) {
    const pad = 92;
    ctx.font = fx(500, 23, SANS); ctx.fillStyle = '#A08A86';
    ctx.textAlign = 'left'; ctx.fillText(handle, pad, H - 84);
    ctx.textAlign = 'right';
    ctx.font = fx(500, 22, SANS); ctx.fillStyle = '#B49B96';
    spaced(ctx, p2(idx) + ' / ' + p2(total), W - pad, H - 84, 2, 'right');
    ctx.textAlign = 'left';
    ctx.strokeStyle = 'rgba(208,126,104,0.45)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad, H - 118); ctx.lineTo(W - pad, H - 118); ctx.stroke();
  }

  function d2Dots(ctx, W, idx, total, y) {
    const gap = 16, r = 4;
    const start = W / 2 - ((total - 1) * gap) / 2;
    for (let i = 1; i <= total; i++) {
      ctx.beginPath(); ctx.arc(start + (i - 1) * gap, y, i === idx ? 4.5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = i === idx ? C2.accent : 'rgba(208,126,104,0.32)'; ctx.fill();
    }
  }

  function drawPastel(ctx, o) {
    const { W, H, card, index, total, handle } = o;
    const pad = 120, tall = H > 1500;
    d2Bg(ctx, W, H);

    if (card.type === 'cover') {
      d2Frame(ctx, W, H);
      ctx.font = fx(600, 22, SANS); ctx.fillStyle = C2.accent;
      spaced(ctx, 'M A G A Z I N E', W / 2, 152, 7, 'center');
      ctx.strokeStyle = 'rgba(208,126,104,0.6)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(W / 2 - 34, 176); ctx.lineTo(W / 2 + 34, 176); ctx.stroke();

      const bh = photoBand(ctx, o.photo, W, 196, tall ? 520 : 252, { fade: C2.bg, tintA: 0.06, washA: 0.5, fadeFrom: 0.42, focus: 0.45 });
      const bandBottom = bh ? 196 + bh : 0;

      const titleTop = bh ? bandBottom + 86 : (tall ? 360 : 300);
      const lay = layoutRich(ctx, card.title, { maxW: W - pad * 2, maxLines: bh ? (tall ? 4 : 3) : 4, sizeMax: tall ? 98 : 90, sizeMin: 50, weight: 700, fam: SERIF, lh: 1.42 });
      drawRich(ctx, lay, W / 2, titleTop, { color: C2.deep, align: 'center', numColor: C2.num });

      let cursor = titleTop + lay.height + 26;
      ctx.textAlign = 'center'; ctx.fillStyle = C2.accent;
      ctx.font = fx(400, 30, SERIF); ctx.fillText('✦', W / 2, cursor + 30); ctx.textAlign = 'left';
      cursor += 66;

      if (card.body) {
        const avail = (card.statNum && !bh ? H - 430 : H - 210) - cursor;
        const maxLines = Math.max(1, Math.min(tall ? 5 : 4, Math.floor(avail / 54)));
        const sub = layoutRich(ctx, card.body, { maxW: W - pad * 2 - 40, maxLines, sizeMax: 31, sizeMin: 23, weight: 400, lh: 1.8 });
        drawRich(ctx, sub, W / 2, cursor + sub.size, { color: C2.sub, align: 'center', numColor: C2.num });
        cursor += sub.height;
      }

      if (card.statNum && bh) {
        statOnPhoto(ctx, card, { W, pad, base: bandBottom - 94, color: '#FFFFFF', size: 92, fam: SERIF });
      } else if (card.statNum) {
        ctx.strokeStyle = 'rgba(208,126,104,0.5)'; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(W / 2, H - 330, 112, 0, Math.PI * 2); ctx.stroke();
        const s = fitOneLine(ctx, card.statNum, { size: 92, min: 48, weight: 600, fam: SERIF, maxW: 190 });
        ctx.font = fx(600, s, SERIF); ctx.fillStyle = C2.num; ctx.textAlign = 'center';
        ctx.fillText(card.statNum, W / 2, H - 330 + s * 0.35);
        if (card.statLabel) {
          ctx.font = fx(500, 23, SANS); ctx.fillStyle = C2.sub;
          const l = layoutRich(ctx, card.statLabel, { maxW: W - pad * 2 - 120, maxLines: 2, sizeMax: 23, sizeMin: 18, weight: 500, lh: 1.6 });
          drawRich(ctx, l, W / 2, H - 186, { color: C2.sub, align: 'center' });
        }
        ctx.textAlign = 'left';
      }

      d2Foot(ctx, W, H, handle, index, total);
      d2Dots(ctx, W, index, total, H - 152);
      return;
    }

    if (card.type === 'content') {
      d2Dots(ctx, W, index, total, 118);
      const p = 108;
      ctx.font = fx(700, 60, SERIF); ctx.fillStyle = C2.accent;
      ctx.fillText(p2(index), p, 232);
      const nw = ctx.measureText(p2(index)).width;
      ctx.font = fx(600, 19, SANS); ctx.fillStyle = '#B08A7E';
      spaced(ctx, card.badge || 'POINT', p + nw + 20, 226, 3.2);

      ctx.strokeStyle = 'rgba(208,126,104,0.45)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p, 268); ctx.lineTo(W - p, 268); ctx.stroke();

      const bh = photoBand(ctx, o.photo, W, 284, tall ? 460 : 270, { fade: C2.bg, tintA: 0.06, washA: 0.45, fadeFrom: 0.46, focus: 0.45 });
      const bandBottom = bh ? 284 + bh : 0;

      const titleTop = bh ? bandBottom + 40 : (tall ? 360 : 336);
      const lay = layoutRich(ctx, card.title, { maxW: W - p * 2, maxLines: 3, sizeMax: tall ? 86 : 68, sizeMin: 42, weight: 700, fam: SERIF, lh: 1.46 });
      drawRich(ctx, lay, p, titleTop + lay.size * 0.8, { color: C2.deep, numColor: C2.num });

      const bodyTop = titleTop + lay.height + 64;
      const bottom = card.statNum && !bh ? H - 500 : H - 220;
      const bodySize = tall ? 37 : 31;
      const maxLines = Math.max(1, Math.floor((bottom - bodyTop) / (bodySize * 1.95)));
      const body = layoutRich(ctx, card.body, { maxW: W - p * 2, maxLines, sizeMax: bodySize, sizeMin: 18, weight: 400, lh: 1.95 });
      drawRich(ctx, body, p, bodyTop + body.size, { color: C2.sub, numColor: C2.num });

      if (card.statNum && bh) {
        statOnPhoto(ctx, card, { W, pad: p, base: bandBottom - 66, color: '#FFFFFF', size: 88, fam: SERIF });
      } else if (card.statNum) {
        const cy = Math.min(H - 356, bodyTop + body.height + 200);
        ctx.strokeStyle = 'rgba(208,126,104,0.45)'; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(W / 2, cy, 104, 0, Math.PI * 2); ctx.stroke();
        const s = fitOneLine(ctx, card.statNum, { size: 86, min: 44, weight: 600, fam: SERIF, maxW: 170 });
        ctx.font = fx(600, s, SERIF); ctx.fillStyle = C2.num; ctx.textAlign = 'center';
        ctx.fillText(card.statNum, W / 2, cy + s * 0.35);
        if (card.statLabel) {
          ctx.font = fx(500, 22, SANS); ctx.fillStyle = C2.sub;
          const l = layoutRich(ctx, card.statLabel, { maxW: W - p * 2 - 140, maxLines: 2, sizeMax: 22, sizeMin: 17, weight: 500, lh: 1.6 });
          drawRich(ctx, l, W / 2, cy + 134, { color: C2.sub, align: 'center' });
        }
        ctx.textAlign = 'left';
      }
      d2Foot(ctx, W, H, handle, index, total);
      return;
    }

    /* CTA */
    d2Frame(ctx, W, H);
    d2Dots(ctx, W, index, total, 118);
    const p = 108;
    ctx.font = fx(600, 21, SANS); ctx.fillStyle = C2.accent;
    spaced(ctx, card.badge || 'S A V E   T H I S', W / 2, 236, 3, 'center');

    const lay = layoutRich(ctx, card.title, { maxW: W - p * 2, maxLines: 3, sizeMax: 82, sizeMin: 48, weight: 700, fam: SERIF, lh: 1.42 });
    let yy = 372;
    drawRich(ctx, lay, W / 2, yy, { color: C2.deep, align: 'center', numColor: C2.num });
    yy += lay.height + 46;

    ctx.strokeStyle = 'rgba(208,126,104,0.55)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(W / 2 - 60, yy); ctx.lineTo(W / 2 + 60, yy); ctx.stroke();
    yy += 56;

    const items = (card.bullets || []).slice(0, 4);
    if (items.length) {
      const bl = layoutBullets(ctx, items, { maxW: W - p * 2 - 40, indent: 0, size: 29, weight: 500, lh: 1.8, gap: 26 });
      const n = bl.items.length;
      const lh = 29 * 1.8;
      const total = bl.items.reduce((a, l) => a + l.length * lh, 0);
      const bandTop = yy + 16, bandBottom = H - 320;
      let gap = n > 1 ? ((bandBottom - bandTop) - total) / (n - 1) : 0;
      gap = Math.max(24, Math.min(gap, 96));
      let by = bandTop + Math.max(0, ((bandBottom - bandTop) - (total + gap * (n - 1))) / 2);
      bl.items.forEach((lines, i) => {
        lines.forEach((line) => {
          let cx = W / 2 - line.w / 2;
          for (const seg of line.segs) {
            ctx.fillStyle = seg.s === 'n' ? C2.num : C2.sub;
            ctx.fillText(seg.t, cx, by); cx += ctx.measureText(seg.t).width;
          }
          by += lh;
        });
        if (i < n - 1) by += gap;
      });
      yy = by;
    }

    if (card.body) {
      const sub = layoutRich(ctx, card.body, { maxW: W - p * 2 - 80, maxLines: 2, sizeMax: 25, sizeMin: 18, weight: 400, lh: 1.75 });
      drawRich(ctx, sub, W / 2, Math.min(yy + 34, H - 300), { color: C2.sub, align: 'center' });
    }

    ctx.fillStyle = C2.accent; ctx.textAlign = 'center';
    ctx.font = fx(600, 25, SANS);
    spaced(ctx, card.cta || '저장 · 공유 · 팔로우', W / 2, H - 236, 2.6, 'center');
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(208,126,104,0.5)'; ctx.fillRect(W / 2 - 28, H - 208, 56, 1);

    d2Foot(ctx, W, H, handle, index, total);
  }

  /* =====================================================================
     THEME 3 — 네온 숏폼형
     ===================================================================== */
  const C3 = { bg: '#08060F', cyan: '#00E5FF', magenta: '#FF2E9A', text: '#F3EFFF', sub: '#B4ADD2', num: '#00E5FF' };

  function d3Bg(ctx, W, H) {
    ctx.fillStyle = C3.bg; ctx.fillRect(0, 0, W, H);
    const g1 = ctx.createRadialGradient(W * 0.15, H * 0.08, 0, W * 0.15, H * 0.08, W * 0.8);
    g1.addColorStop(0, 'rgba(0,229,255,0.22)'); g1.addColorStop(1, 'rgba(0,229,255,0)');
    ctx.fillStyle = g1; ctx.fillRect(0, 0, W, H);
    const g2 = ctx.createRadialGradient(W * 0.9, H * 0.9, 0, W * 0.9, H * 0.9, W * 0.8);
    g2.addColorStop(0, 'rgba(255,46,154,0.24)'); g2.addColorStop(1, 'rgba(255,46,154,0)');
    ctx.fillStyle = g2; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.045)'; ctx.lineWidth = 1;
    for (let x = 90; x < W; x += 90) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 90; y < H; y += 90) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    noise(ctx, W, H, 0.04, 500);
  }

  function d3Corners(ctx, W, H) {
    const i = 40, L = 62;
    ctx.strokeStyle = 'rgba(0,229,255,0.55)'; ctx.lineWidth = 3;
    [[i, i, 1, 1], [W - i, i, -1, 1], [i, H - i, 1, -1], [W - i, H - i, -1, -1]].forEach(([x, y, sx, sy]) => {
      ctx.beginPath(); ctx.moveTo(x + L * sx, y); ctx.lineTo(x, y); ctx.lineTo(x, y + L * sy); ctx.stroke();
    });
  }

  function d3Pill(ctx, x, y, text, W) {
    ctx.font = fx(700, 23, SANS);
    const tw = measureSpaced(ctx, text, 3.4);
    const w = tw + 56, h = 54;
    ctx.save();
    ctx.shadowColor = 'rgba(0,229,255,0.75)'; ctx.shadowBlur = 22;
    ctx.strokeStyle = C3.cyan; ctx.lineWidth = 2;
    rr(ctx, x, y, w, h, h / 2); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = C3.cyan;
    spaced(ctx, text, x + w / 2, y + 36, 3.4, 'center');
    return w;
  }

  function d3Foot(ctx, W, H, handle, idx, total) {
    const pad = 80;
    ctx.save();
    ctx.shadowColor = 'rgba(0,229,255,0.55)'; ctx.shadowBlur = 16;
    ctx.font = fx(700, 24, SANS); ctx.fillStyle = C3.cyan;
    ctx.fillText(handle, pad, H - 74);
    ctx.restore();
    ctx.font = fx(700, 22, SANS);
    const t = p2(idx) + ' / ' + p2(total);
    const tw = measureSpaced(ctx, t, 1.6), w = tw + 40;
    ctx.strokeStyle = 'rgba(255,46,154,0.8)'; ctx.lineWidth = 1.5;
    rr(ctx, W - pad - w, H - 106, w, 46, 8); ctx.stroke();
    ctx.fillStyle = C3.magenta;
    spaced(ctx, t, W - pad - w / 2, H - 75, 1.6, 'center');
  }

  function d3Progress(ctx, W, idx, total) {
    const pad = 80, w = W - pad * 2, y = 62;
    ctx.fillStyle = 'rgba(255,255,255,0.10)'; rr(ctx, pad, y, w, 5, 3); ctx.fill();
    const g = ctx.createLinearGradient(pad, 0, pad + w, 0);
    g.addColorStop(0, C3.cyan); g.addColorStop(1, C3.magenta);
    ctx.fillStyle = g; rr(ctx, pad, y, Math.max(8, w * idx / total), 5, 3); ctx.fill();
  }

  function d3Stat(ctx, W, H, card, cy) {
    const s = fitOneLine(ctx, card.statNum, { size: 138, min: 62, weight: 900, maxW: W - 200 });
    ctx.save();
    ctx.font = fx(900, s, SANS); ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(255,46,154,0.85)'; ctx.shadowBlur = 40;
    ctx.fillStyle = C3.magenta; ctx.fillText(card.statNum, W / 2, cy);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#FFFFFF'; ctx.globalAlpha = 0.95; ctx.fillText(card.statNum, W / 2, cy);
    ctx.globalAlpha = 1; ctx.restore();
    ctx.textAlign = 'center';
    if (card.statLabel) {
      const l = layoutRich(ctx, card.statLabel, { maxW: W - 240, maxLines: 2, sizeMax: 25, sizeMin: 18, weight: 600, lh: 1.55 });
      drawRich(ctx, l, W / 2, cy + 52, { color: C3.sub, align: 'center', numColor: C3.cyan });
    }
    ctx.textAlign = 'left';
  }

  function drawNeon(ctx, o) {
    const { W, H, card, index, total, handle } = o;
    const tall = H > 1500;
    d3Bg(ctx, W, H);
    d3Corners(ctx, W, H);

    if (card.type === 'cover') {
      d3Pill(ctx, W / 2 - 82, 108, card.badge || 'SHORTS', W);
      const grad = ctx.createLinearGradient(W * 0.12, 0, W * 0.88, 0);
      grad.addColorStop(0, '#00E5FF'); grad.addColorStop(0.5, '#B388FF'); grad.addColorStop(1, '#FF2E9A');

      const bh = photoBand(ctx, o.photo, W, 176, tall ? 600 : 380, { fade: C3.bg, tintA: 0.16, washA: 0.6 });
      const bandBottom = bh ? 176 + bh : 0;

      const titleTop = bh ? bandBottom + 78 : (tall ? 400 : 340);
      const lay = layoutRich(ctx, card.title, { maxW: W - 160, maxLines: bh ? (tall ? 4 : 3) : 4, sizeMax: tall ? 118 : 110, sizeMin: 52, weight: 900, lh: 1.14 });
      ctx.save();
      ctx.shadowColor = 'rgba(120,60,255,0.8)'; ctx.shadowBlur = 26;
      drawRich(ctx, lay, W / 2, titleTop, { grad: grad, align: 'center' });
      ctx.restore();

      let cursor = titleTop + lay.height + 34;
      if (card.body) {
        const avail = (card.statNum && !bh ? H - 400 : H - 190) - cursor;
        const maxLines = Math.max(1, Math.min(tall ? 5 : 4, Math.floor(avail / 52)));
        const sub = layoutRich(ctx, card.body, { maxW: W - 200, maxLines, sizeMax: 31, sizeMin: 22, weight: 500, lh: 1.62 });
        drawRich(ctx, sub, W / 2, cursor + sub.size, { color: C3.sub, align: 'center', numColor: C3.num });
        cursor += sub.height;
      }
      if (card.statNum && bh) statOnPhoto(ctx, card, { W, pad: 80, base: bandBottom - 96, color: '#FFFFFF', size: 92 });
      else if (card.statNum) d3Stat(ctx, W, H, card, H - 300);

      ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.font = fx(600, 21, SANS); ctx.textAlign = 'center';
      spaced(ctx, 'S L I D E  →', W / 2, H - 156, 1.5, 'center');
      ctx.textAlign = 'left';
      d3Foot(ctx, W, H, handle, index, total);
      return;
    }

    if (card.type === 'content') {
      d3Progress(ctx, W, index, total);
      d3Pill(ctx, 80, 128, card.badge || ('EP.' + p2(index)), W);

      const bh = photoBand(ctx, o.photo, W, 190, tall ? 520 : 320, { fade: C3.bg, tintA: 0.16, washA: 0.55 });
      const bandBottom = bh ? 190 + bh : 0;

      const titleTop = bh ? bandBottom + 46 : (tall ? 330 : 300);
      const lay = layoutRich(ctx, card.title, { maxW: W - 160, maxLines: 3, sizeMax: tall ? 106 : 84, sizeMin: 46, weight: 900, lh: 1.18, align: 'center' });
      ctx.save();
      ctx.shadowColor = 'rgba(0,229,255,0.6)'; ctx.shadowBlur = 24;
      drawRich(ctx, lay, W / 2, titleTop + lay.size * 0.9, { color: C3.text, align: 'center', numColor: C3.cyan });
      ctx.restore();

      const bodyTop = titleTop + lay.height + 52;
      const bottom = card.statNum && !bh ? H - 400 : H - 180;
      const bodySize = tall ? 40 : 31;
      const maxLines = Math.max(1, Math.floor((bottom - bodyTop) / (bodySize * 1.7)));
      const body = layoutRich(ctx, card.body, { maxW: W - 170, maxLines, sizeMax: bodySize, sizeMin: 21, weight: 500, lh: 1.7 });
      drawRich(ctx, body, W / 2, bodyTop + body.size, { color: C3.sub, align: 'center', numColor: C3.cyan });

      if (card.statNum && bh) {
        statOnPhoto(ctx, card, { W, pad: 80, base: bandBottom - 66, color: '#FFFFFF', size: 88 });
      } else if (card.statNum) {
        const cy = Math.min(H - 258, bodyTop + body.height + 250);
        ctx.strokeStyle = 'rgba(0,229,255,0.35)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(140, cy - 134); ctx.lineTo(W - 140, cy - 134); ctx.stroke();
        d3Stat(ctx, W, H, card, cy);
      }
      d3Foot(ctx, W, H, handle, index, total);
      return;
    }

    /* CTA */
    d3Progress(ctx, W, index, total);
    const px = 70, py = 190, pw = W - 140, ph = H - py - 200;
    ctx.save();
    ctx.shadowColor = 'rgba(120,60,255,0.55)'; ctx.shadowBlur = 40;
    ctx.fillStyle = 'rgba(12,10,22,0.72)'; rr(ctx, px, py, pw, ph, 30); ctx.fill();
    ctx.restore();
    const gb = ctx.createLinearGradient(px, py, px + pw, py + ph);
    gb.addColorStop(0, C3.cyan); gb.addColorStop(1, C3.magenta);
    ctx.strokeStyle = gb; ctx.lineWidth = 2.5; rr(ctx, px, py, pw, ph, 30); ctx.stroke();

    const ip = px + 62, iw = pw - 124;
    ctx.font = fx(700, 22, SANS); ctx.fillStyle = C3.cyan;
    spaced(ctx, card.badge || 'FOLLOW ME', ip, py + 96, 3.6);

    const lay = layoutRich(ctx, card.title, { maxW: iw, maxLines: 3, sizeMax: 78, sizeMin: 44, weight: 900, lh: 1.18 });
    drawRich(ctx, lay, ip, py + 186, { color: C3.text, numColor: C3.cyan });

    let by = py + 186 + lay.height + 30;
    const items = (card.bullets || []).slice(0, 4);
    const ctaBarTop = py + ph - 116;
    if (items.length) {
      const bl = layoutBullets(ctx, items, { maxW: iw, indent: 34, size: 29, weight: 600, lh: 1.6, gap: 14 });
      drawBulletsSpread(ctx, bl, ip, by + 10, ctaBarTop - 60, {
        color: C3.sub, numColor: C3.cyan, size: 29, weight: 600, lh: 1.6, indent: 34, maxGap: 112,
        glyph: '▸', glyphColor: C3.magenta, glyphSize: 24
      });
    }

    if (card.body) {
      const sub = layoutRich(ctx, card.body, { maxW: iw - 20, maxLines: 2, sizeMax: 25, sizeMin: 18, weight: 500, lh: 1.6 });
      drawRich(ctx, sub, ip, py + ph - 190, { color: 'rgba(180,173,210,0.85)', numColor: C3.cyan });
    }

    ctx.save();
    ctx.shadowColor = 'rgba(255,46,154,0.7)'; ctx.shadowBlur = 26;
    ctx.fillStyle = gb; rr(ctx, ip, py + ph - 116, iw, 74, 37); ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.shadowColor = 'rgba(255,255,255,0.6)'; ctx.shadowBlur = 14;
    ctx.fillStyle = '#08060F'; ctx.font = fx(900, 27, SANS); ctx.textAlign = 'center';
    spaced(ctx, card.cta || '저장 · 공유 · 팔로우', ip + iw / 2, py + ph - 68, 1.2, 'center');
    ctx.restore();
    ctx.textAlign = 'left';

    d3Foot(ctx, W, H, handle, index, total);
  }

  /* =====================================================================
     THEME 4 — 미니멀 화이트형
     ===================================================================== */
  const C4 = { bg: '#FFFFFF', ink: '#141414', sub: '#6E6E6E', faint: '#A5A5A5', hair: '#E6E6E6', accent: '#FF4D2E' };

  function d4Top(ctx, W, idx, total, label) {
    const pad = 96;
    ctx.font = fx(600, 16, SANS); ctx.fillStyle = C4.faint;
    spaced(ctx, (label || 'CARD NEWS').toUpperCase(), pad, 92, 4);
    ctx.textAlign = 'right';
    spaced(ctx, p2(idx) + ' / ' + p2(total), W - pad, 92, 2.4, 'right');
    ctx.textAlign = 'left';
    ctx.fillStyle = C4.hair; ctx.fillRect(pad, 122, W - pad * 2, 1);
  }

  function d4TopNoPage(ctx, W, label) {
    const pad = 96;
    ctx.font = fx(600, 16, SANS); ctx.fillStyle = C4.faint;
    spaced(ctx, (label || 'CARD NEWS').toUpperCase(), pad, 92, 4);
    ctx.fillStyle = C4.hair; ctx.fillRect(pad, 122, W - pad * 2, 1);
  }

  function d4Foot(ctx, W, H, handle, idx, total) {
    const pad = 96;
    ctx.fillStyle = C4.hair; ctx.fillRect(pad, H - 128, W - pad * 2, 1);
    ctx.font = fx(500, 22, SANS); ctx.fillStyle = '#8A8A8A';
    ctx.fillText(handle, pad, H - 76);
  }

  function drawMinimal(ctx, o) {
    const { W, H, card, index, total, handle } = o;
    const pad = 96, tall = H > 1500;
    ctx.fillStyle = C4.bg; ctx.fillRect(0, 0, W, H);

    if (card.type === 'cover') {
      d4Top(ctx, W, index, total, 'CARD NEWS');

      const bh = photoBand(ctx, o.photo, W, 146, tall ? 540 : 300, { fade: C4.bg, tintA: 0.04, washA: 0.62, fadeFrom: 0.46, focus: 0.45 });
      const bandBottom = bh ? 146 + bh : 0;

      const top = bh ? bandBottom + 42 : (tall ? 300 : 250);
      ctx.fillStyle = C4.accent; ctx.fillRect(pad, top, 20, 20);

      const lay = layoutRich(ctx, card.title, { maxW: W - pad * 2, maxLines: bh ? 3 : 4, sizeMax: tall ? 96 : 86, sizeMin: 48, weight: 700, lh: 1.32 });
      drawRich(ctx, lay, pad, top + 56 + lay.size, { color: C4.ink, numColor: C4.accent });

      let cursor = top + 56 + lay.height + 44;
      if (card.body) {
        const avail = (card.statNum && !bh ? H - 420 : H - 200) - cursor;
        const maxLines = Math.max(1, Math.min(tall ? 5 : 4, Math.floor(avail / 57)));
        const sub = layoutRich(ctx, card.body, { maxW: W - pad * 2 - 90, maxLines, sizeMax: 30, sizeMin: 22, weight: 400, lh: 1.9 });
        drawRich(ctx, sub, pad, cursor + sub.size, { color: C4.sub, numColor: C4.accent });
      }

      if (card.statNum && bh) {
        statOnPhoto(ctx, card, { W, pad, base: bandBottom - 66, color: '#FFFFFF', size: 88 });
      } else if (card.statNum) {
        const s = fitOneLine(ctx, card.statNum, { size: 132, min: 56, weight: 200, maxW: W - pad * 2 });
        ctx.font = fx(200, s, SANS); ctx.fillStyle = C4.ink;
        ctx.fillText(card.statNum, pad, H - 320);
        if (card.statLabel) {
          const l = layoutRich(ctx, card.statLabel, { maxW: W - pad * 2 - 60, maxLines: 2, sizeMax: 24, sizeMin: 18, weight: 400, lh: 1.6 });
          drawRich(ctx, l, pad, H - 254, { color: C4.faint });
        }
      } else {
        ctx.fillStyle = C4.hair; ctx.fillRect(pad, H - 210, 120, 1);
        ctx.font = fx(500, 20, SANS); ctx.fillStyle = C4.faint;
        spaced(ctx, 'SWIPE', pad + 140, H - 203, 3);
      }
      d4Foot(ctx, W, H, handle, index, total);
      return;
    }

    if (card.type === 'content') {
      d4Top(ctx, W, index, total, card.badge || 'POINT ' + p2(index));

      const bh = photoBand(ctx, o.photo, W, 146, tall ? 500 : 280, { fade: C4.bg, tintA: 0.04, washA: 0.55, fadeFrom: 0.46, focus: 0.45 });
      const bandBottom = bh ? 146 + bh : 0;

      const top = bh ? bandBottom + 26 : (tall ? 330 : 300);
      const lay = layoutRich(ctx, card.title, { maxW: W - pad * 2, maxLines: 3, sizeMax: tall ? 82 : 62, sizeMin: 40, weight: 700, lh: 1.42 });
      drawRich(ctx, lay, pad, top + lay.size, { color: C4.ink, numColor: C4.accent });

      const bodyTop = top + lay.height + 50;
      const bottom = card.statNum && !bh ? H - 430 : H - 210;
      const bodySize = tall ? 38 : 30;
      const maxLines = Math.max(1, Math.floor((bottom - bodyTop) / (bodySize * 1.95)));
      const body = layoutRich(ctx, card.body, { maxW: W - pad * 2 - 30, maxLines, sizeMax: bodySize, sizeMin: 21, weight: 400, lh: 1.95 });
      drawRich(ctx, body, pad, bodyTop + body.size, { color: C4.sub, numColor: C4.accent });

      if (card.statNum && bh) {
        statOnPhoto(ctx, card, { W, pad, base: bandBottom - 62, color: '#FFFFFF', size: 84 });
      } else if (card.statNum) {
        const top = Math.min(H - 400, bodyTop + body.height + 150);
        ctx.fillStyle = C4.hair; ctx.fillRect(pad, top, W - pad * 2, 1);
        const s = fitOneLine(ctx, card.statNum, { size: 122, min: 54, weight: 200, maxW: W - pad * 2 });
        ctx.font = fx(200, s, SANS); ctx.fillStyle = C4.accent;
        ctx.fillText(card.statNum, pad, top + 128);
        if (card.statLabel) {
          const l = layoutRich(ctx, card.statLabel, { maxW: W - pad * 2 - 60, maxLines: 2, sizeMax: 22, sizeMin: 17, weight: 400, lh: 1.6 });
          drawRich(ctx, l, pad, top + 188, { color: C4.faint });
        }
      }
      d4Foot(ctx, W, H, handle, index, total);
      return;
    }

    /* CTA */
    d4Top(ctx, W, index, total, card.badge || 'SUMMARY');
    const p = 110;
    ctx.font = fx(500, 20, SANS); ctx.fillStyle = C4.faint;
    spaced(ctx, 'SAVE FOR LATER', p, 300, 3.4);

    const lay = layoutRich(ctx, card.title, { maxW: W - p * 2, maxLines: 3, sizeMax: 74, sizeMin: 44, weight: 700, lh: 1.34 });
    drawRich(ctx, lay, p, 350 + lay.size, { color: C4.ink, numColor: C4.accent });

    let by = 350 + lay.height + 60;
    const items = (card.bullets || []).slice(0, 4);
    if (items.length) {
      const bl = layoutBullets(ctx, items, { maxW: W - p * 2, indent: 30, size: 29, weight: 400, lh: 1.7, gap: 14 });
      drawBulletsSpread(ctx, bl, p, by, H - 330, {
        color: C4.sub, numColor: C4.accent, size: 29, weight: 400, lh: 1.7, indent: 30, maxGap: 96,
        glyph: '·', glyphColor: C4.accent, glyphSize: 34
      });
    }
    ctx.fillStyle = C4.ink; ctx.font = fx(600, 22, SANS);
    spaced(ctx, card.cta || '저장 · 공유 · 팔로우', p, H - 196, 2.2);
    d4Foot(ctx, W, H, handle, index, total);
  }

  /* =====================================================================
     THEME 5 — 경제 신문형
     ===================================================================== */
  const C5 = { bg: '#F7F5EE', ink: '#161616', sub: '#3D3D3D', accent: '#0B5D3B', red: '#B3261E', rule: '#1D1D1D', faint: '#6B6B63' };

  function d5Bg(ctx, W, H) {
    ctx.fillStyle = C5.bg; ctx.fillRect(0, 0, W, H);
    const g = ctx.createRadialGradient(W * 0.5, 0, 0, W * 0.5, 0, H);
    g.addColorStop(0, 'rgba(255,255,255,0.6)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(29,29,29,0.035)'; ctx.lineWidth = 1;
    for (let y = 0; y < H; y += 6) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  }

  function d5Mast(ctx, W) {
    const pad = 76;
    ctx.fillStyle = C5.rule; ctx.fillRect(pad, 62, W - pad * 2, 6);
    ctx.font = fx(800, 32, SERIF); ctx.fillStyle = C5.ink;
    ctx.fillText('經濟新聞', pad, 118);
    const kw = ctx.measureText('經濟新聞').width;
    ctx.font = fx(600, 14, SANS); ctx.fillStyle = C5.faint;
    spaced(ctx, 'ECONOMY DAILY', pad + kw + 18, 114, 2.6);
    ctx.textAlign = 'right';
    ctx.font = fx(500, 18, SERIF); ctx.fillStyle = C5.sub;
    ctx.fillText(dateKo(), W - pad, 116);
    ctx.textAlign = 'left';
    ctx.fillStyle = C5.rule; ctx.fillRect(pad, 136, W - pad * 2, 1.6);
    ctx.fillStyle = C5.rule; ctx.fillRect(pad, 140, W - pad * 2, 0.8);
  }

  function d5MastMini(ctx, W, label) {
    const pad = 76;
    ctx.fillStyle = C5.rule; ctx.fillRect(pad, 62, W - pad * 2, 1.6);
    ctx.font = fx(700, 20, SERIF); ctx.fillStyle = C5.ink;
    ctx.fillText('經濟新聞', pad, 100);
    const kw = ctx.measureText('經濟新聞').width;
    ctx.font = fx(600, 12, SANS); ctx.fillStyle = C5.faint;
    spaced(ctx, 'ECONOMY DAILY', pad + kw + 12, 96, 2.2);
    ctx.textAlign = 'right'; ctx.font = fx(500, 16, SERIF); ctx.fillStyle = C5.sub;
    ctx.fillText(dateKo() + '  ·  ' + (label || ''), W - pad, 100);
    ctx.textAlign = 'left';
    ctx.fillStyle = C5.rule; ctx.fillRect(pad, 112, W - pad * 2, 1.4);
  }

  function d5Foot(ctx, W, H, handle, idx, total) {
    const pad = 76;
    ctx.fillStyle = 'rgba(29,29,29,0.35)'; ctx.fillRect(pad, H - 122, W - pad * 2, 1);
    ctx.fillStyle = C5.rule; ctx.fillRect(pad, H - 118, W - pad * 2, 2);
    ctx.font = fx(500, 21, SERIF); ctx.fillStyle = C5.sub;
    ctx.fillText(handle, pad, H - 72);
    ctx.textAlign = 'right'; ctx.font = fx(600, 20, SERIF); ctx.fillStyle = C5.ink;
    ctx.fillText(p2(idx) + ' / ' + p2(total), W - pad, H - 72);
    ctx.textAlign = 'left';
  }

  function d5Kicker(ctx, x, y, text) {
    ctx.font = fx(800, 21, SANS);
    const tw = measureSpaced(ctx, text, 1.6);
    ctx.fillStyle = C5.ink; ctx.fillRect(x, y, tw + 34, 46);
    ctx.fillStyle = C5.bg;
    spaced(ctx, text, x + 17, y + 30, 1.6);
    return tw + 34;
  }

  function d5Stat(ctx, W, H, card, boxTop, boxH) {
    const pad = 76, w = W - pad * 2;
    ctx.strokeStyle = C5.rule; ctx.lineWidth = 2.2;
    ctx.strokeRect(pad, boxTop, w, boxH);
    ctx.lineWidth = 1;
    ctx.strokeRect(pad + 7, boxTop + 7, w - 14, boxH - 14);
    ctx.fillStyle = 'rgba(11,93,59,0.06)'; ctx.fillRect(pad + 8, boxTop + 8, w - 16, boxH - 16);

    ctx.font = fx(600, 15, SANS); ctx.fillStyle = C5.accent;
    spaced(ctx, 'KEY FIGURE', pad + 34, boxTop + 48, 3);

    const s = fitOneLine(ctx, card.statNum, { size: 96, min: 44, weight: 800, fam: SERIF, maxW: w - 64 });
    ctx.font = fx(800, s, SERIF); ctx.fillStyle = C5.accent;
    ctx.fillText(card.statNum, pad + 34, boxTop + boxH - 46);
    if (card.statLabel) {
      ctx.font = fx(500, 22, SERIF); ctx.fillStyle = C5.sub;
      const l = layoutRich(ctx, card.statLabel, { maxW: w - 120, maxLines: 2, sizeMax: 22, sizeMin: 17, weight: 500, fam: SERIF, lh: 1.5 });
      ctx.textAlign = 'right';
      drawRich(ctx, l, pad + w - 34, boxTop + boxH - 50, { color: C5.sub, align: 'right' });
      ctx.textAlign = 'left';
    }
  }

  function drawNews(ctx, o) {
    const { W, H, card, index, total, handle } = o;
    const pad = 76, tall = H > 1500;
    d5Bg(ctx, W, H);

    if (card.type === 'cover') {
      d5Mast(ctx, W);

      const bh = photoBand(ctx, o.photo, W, 158, tall ? 560 : 360, { fade: C5.bg, tintA: 0.05, washA: 0.62, fadeFrom: 0.46, focus: 0.45 });
      const bandBottom = bh ? 158 + bh : 0;
      d5Kicker(ctx, pad, 182, card.badge || '카드뉴스');

      const titleTop = bh ? bandBottom + 66 : (tall ? 350 : 300);
      const lay = layoutRich(ctx, card.title, { maxW: W - pad * 2, maxLines: bh ? 3 : 4, sizeMax: tall ? 96 : 88, sizeMin: 48, weight: 800, fam: SERIF, lh: 1.3 });
      drawRich(ctx, lay, pad, titleTop + lay.size, { color: C5.ink, numColor: C5.red });

      let cursor = titleTop + lay.height + 26;
      ctx.fillStyle = C5.rule; ctx.fillRect(pad, cursor, W - pad * 2, 2);
      cursor += 44;

      if (card.body) {
        const avail = (card.statNum && !bh ? H - 470 : H - 200) - cursor;
        const maxLines = Math.max(1, Math.min(tall ? 5 : 4, Math.floor(avail / 54)));
        const sub = layoutRich(ctx, card.body, { maxW: W - pad * 2, maxLines, sizeMax: 30, sizeMin: 21, weight: 400, fam: SERIF, lh: 1.8 });
        drawRich(ctx, sub, pad, cursor + sub.size, { color: C5.sub, numColor: C5.red });
        cursor += sub.height;
      }

      if (card.statNum && bh) {
        statOnPhoto(ctx, card, { W, pad, base: bandBottom - 66, color: '#FFFFFF', size: 88, fam: SERIF });
      } else if (card.statNum) d5Stat(ctx, W, H, card, H - 360, 200);
      else {
        ctx.font = fx(500, 19, SANS); ctx.fillStyle = C5.faint;
        spaced(ctx, '다음 장에서 계속', pad, H - 210, 1.6);
      }
      d5Foot(ctx, W, H, handle, index, total);
      return;
    }

    if (card.type === 'content') {
      d5MastMini(ctx, W, 'POINT ' + p2(index));

      const bh = photoBand(ctx, o.photo, W, 132, tall ? 520 : 310, { fade: C5.bg, tintA: 0.05, washA: 0.55, fadeFrom: 0.46, focus: 0.45 });
      const bandBottom = bh ? 132 + bh : 0;
      d5Kicker(ctx, pad, 168, card.badge || ('핵심 ' + p2(index)));

      const titleTop = bh ? bandBottom + 44 : (tall ? 340 : 306);
      const lay = layoutRich(ctx, card.title, { maxW: W - pad * 2, maxLines: 3, sizeMax: tall ? 82 : 62, sizeMin: 40, weight: 800, fam: SERIF, lh: 1.36 });
      drawRich(ctx, lay, pad, titleTop + lay.size, { color: C5.ink, numColor: C5.red });

      let bodyTop = titleTop + lay.height + 30;
      ctx.fillStyle = 'rgba(29,29,29,0.5)'; ctx.fillRect(pad, bodyTop, W - pad * 2, 1);
      bodyTop += 40;

      const bottom = card.statNum && !bh ? H - 400 : H - 190;
      const bodySize = tall ? 36 : 30;
      const maxLines = Math.max(1, Math.floor((bottom - bodyTop) / (bodySize * 1.9)));
      const body = layoutRich(ctx, card.body, { maxW: W - pad * 2, maxLines, sizeMax: bodySize, sizeMin: 18, weight: 400, fam: SERIF, lh: 1.9 });
      drawRich(ctx, body, pad, bodyTop + body.size, { color: C5.sub, numColor: C5.red });

      if (card.statNum && bh) {
        statOnPhoto(ctx, card, { W, pad, base: bandBottom - 62, color: '#FFFFFF', size: 84, fam: SERIF });
      } else if (card.statNum) {
        const top = Math.min(H - 300, bodyTop + body.height + 110);
        d5Stat(ctx, W, H, card, top, 178);
      }
      d5Foot(ctx, W, H, handle, index, total);
      return;
    }

    /* CTA */
    d5MastMini(ctx, W, 'SUMMARY');
    const p = 76, w = W - p * 2;
    const boxTop = tall ? 220 : 196, boxH = H - boxTop - 200;
    ctx.strokeStyle = C5.rule; ctx.lineWidth = 3;
    ctx.strokeRect(p, boxTop, w, boxH);
    ctx.lineWidth = 1;
    ctx.strokeRect(p + 9, boxTop + 9, w - 18, boxH - 18);

    ctx.font = fx(800, 19, SANS); ctx.fillStyle = C5.bg;
    ctx.fillStyle = C5.ink; ctx.fillRect(p + 1.5, boxTop + 26, 74, 40);
    ctx.fillStyle = C5.bg; spaced(ctx, '요약', p + 22, boxTop + 54, 4);

    const lay = layoutRich(ctx, card.title, { maxW: w - 120, maxLines: 3, sizeMax: 72, sizeMin: 42, weight: 800, fam: SERIF, lh: 1.34 });
    drawRich(ctx, lay, p + 40, boxTop + 168, { color: C5.ink, numColor: C5.red });

    let by = boxTop + 168 + lay.height + 24;
    ctx.fillStyle = 'rgba(29,29,29,0.4)'; ctx.fillRect(p + 40, by, w - 80, 1);
    by += 42;

    const items = (card.bullets || []).slice(0, 4);
    if (items.length) {
      const bl = layoutBullets(ctx, items, { maxW: w - 90, indent: 34, size: 28, weight: 500, fam: SERIF, lh: 1.8, gap: 20 });
      drawBulletsSpread(ctx, bl, p + 40, by + 20, boxTop + boxH - 120, {
        color: C5.sub, numColor: C5.red, size: 28, weight: 500, fam: SERIF, lh: 1.8, indent: 34, maxGap: 70,
        glyph: '■', glyphColor: C5.accent, glyphSize: 14
      });
    }
    if (card.body) {
      const sub = layoutRich(ctx, card.body, { maxW: w - 90, maxLines: 2, sizeMax: 24, sizeMin: 17, weight: 400, fam: SERIF, lh: 1.65 });
      drawRich(ctx, sub, p + 40, Math.min(by + 26, boxTop + boxH - 100), { color: C5.faint });
    }
    ctx.fillStyle = C5.ink; ctx.font = fx(700, 24, SERIF);
    spaced(ctx, card.cta || '저장 · 공유 · 구독', p + 40, boxTop + boxH - 44, 1.8);

    d5Foot(ctx, W, H, handle, index, total);
  }

  /* =====================================================================
     요약 카드 (3장 요약 모드의 02장) — 테마 색만 갈아입고 같은 구조로 그린다
     ===================================================================== */
  const SUM_PAL = {
    dark:    { ink: '#FFFFFF', sub: '#ACACB8', chip: '#FF2D2D', chipInk: '#0B0B0F', fam: SANS, weight: 800, rul: 'rgba(255,255,255,0.16)' },
    pastel:  { ink: '#3B2A2C', sub: '#7A6668', chip: '#D07E68', chipInk: '#FBF3EE', fam: SERIF, weight: 700, rul: 'rgba(208,126,104,0.45)' },
    neon:    { ink: '#F3EFFF', sub: '#B4ADD2', chip: '#00E5FF', chipInk: '#08060F', fam: SANS, weight: 800, rul: 'rgba(0,229,255,0.35)' },
    minimal: { ink: '#141414', sub: '#6E6E6E', chip: '#FF4D2E', chipInk: '#FFFFFF', fam: SANS, weight: 700, rul: '#E6E6E6' },
    news:    { ink: '#161616', sub: '#3D3D3D', chip: '#0B5D3B', chipInk: '#F7F5EE', fam: SERIF, weight: 800, rul: 'rgba(29,29,29,0.45)' }
  };

  function drawSummary(ctx, o) {
    const { W, H, card, index, total, handle, theme } = o;
    const id = theme || 'dark';
    const P = SUM_PAL[id] || SUM_PAL.dark;
    const tall = H > 1500;
    const pad = id === 'dark' ? 84 : id === 'minimal' ? 96 : id === 'news' ? 76 : 108;
    let headBottom = 150;

    /* 배경 + 머리말 */
    if (id === 'dark') { d1Bg(ctx, W, H); d1Mast(ctx, W, pad); headBottom = 140; }
    else if (id === 'pastel') { d2Bg(ctx, W, H); d2Frame(ctx, W, H); headBottom = 200; }
    else if (id === 'neon') { d3Bg(ctx, W, H); d3Corners(ctx, W, H); d3Progress(ctx, W, index, total); headBottom = 140; }
    else if (id === 'minimal') { ctx.fillStyle = C4.bg; ctx.fillRect(0, 0, W, H); d4Top(ctx, W, index, total, card.badge || 'SUMMARY'); headBottom = 150; }
    else { d5Bg(ctx, W, H); d5MastMini(ctx, W, 'SUMMARY'); headBottom = 150; }

    /* 라벨 */
    const label = String(card.badge || '3줄 요약');
    ctx.font = fx(800, 21, SANS);
    ctx.fillStyle = (id === 'minimal') ? C4.accent : (id === 'news') ? C5.accent : P.chip;
    if (id === 'pastel') {
      ctx.textAlign = 'center'; spaced(ctx, label, W / 2, headBottom + 46, 3, 'center'); ctx.textAlign = 'left';
    } else {
      spaced(ctx, label, pad, headBottom + 44, 2.6);
    }

    /* 제목 */
    const titleTop = headBottom + 86;
    const lay = layoutRich(ctx, card.title, {
      maxW: W - pad * 2, maxLines: 2, sizeMax: tall ? 92 : 74, sizeMin: 40,
      weight: 900, fam: P.fam, lh: 1.3
    });
    const titleY = titleTop + lay.size * 0.95;
    drawRich(ctx, lay, id === 'pastel' ? W / 2 : pad, titleY, { color: P.ink, align: id === 'pastel' ? 'center' : 'left', numColor: P.chip });

    const ruleY = titleTop + lay.height + 30;
    ctx.fillStyle = P.rul; ctx.fillRect(pad, ruleY, W - pad * 2, id === 'news' ? 2 : 1.5);

    /* 3줄 */
    const rows = (card.bullets || []).slice(0, 3).map(t => String(t).trim()).filter(Boolean);
    if (!rows.length) {
      if (id === 'dark') d1Foot(ctx, W, H, handle, index, total);
      else if (id === 'pastel') { d2Foot(ctx, W, H, handle, index, total); d2Dots(ctx, W, index, total, H - 152); }
      else if (id === 'neon') d3Foot(ctx, W, H, handle, index, total);
      else if (id === 'minimal') d4Foot(ctx, W, H, handle, index, total);
      else d5Foot(ctx, W, H, handle, index, total);
      return;
    }

    const rowSize = tall ? 40 : 33;
    const lhRate = (id === 'pastel' || id === 'news') ? 1.72 : 1.6;
    const lh = rowSize * lhRate;
    const chip = Math.round(rowSize * 1.55);
    const textX = pad + chip + 26;

    const laid = rows.map(t => layoutRich(ctx, t, {
      maxW: W - textX - pad, maxLines: 3, sizeMax: rowSize, sizeMin: 21,
      weight: P.weight, fam: P.fam, lh: lhRate
    }));
    const rowH = laid.map(l => Math.max(l.lines.length * lh, chip));
    const bandTop = ruleY + 44;
    const bandBottom = H - 200;
    const sum = rowH.reduce((a, b) => a + b, 0);
    let gap = rows.length > 1 ? (bandBottom - bandTop - sum) / (rows.length - 1) : 0;
    gap = Math.max(18, Math.min(gap, tall ? 120 : 92));
    let y = bandTop + Math.max(0, (bandBottom - bandTop - (sum + gap * (rows.length - 1))) / 2);

    laid.forEach((l, i) => {
      const rh = rowH[i];
      /* 번호 칩 */
      ctx.fillStyle = P.chip;
      if (id === 'minimal' || id === 'news') rr(ctx, pad, y + 2, chip, chip, 0);
      else rr(ctx, pad, y + 2, chip, chip, id === 'pastel' ? chip / 2 : 10);
      ctx.fill();
      ctx.fillStyle = P.chipInk;
      ctx.font = fx(800, Math.round(chip * 0.42), P.fam);
      ctx.textAlign = 'center';
      ctx.fillText(p2(i + 1), pad + chip / 2, y + 2 + chip * 0.66);
      ctx.textAlign = 'left';

      /* 본문 */
      const textBaseline = y + 2 + (chip - l.lines.length * lh) / 2 + l.size * 0.86;
      drawRich(ctx, l, textX, textBaseline, { color: P.sub, numColor: P.chip });
      y += rh + gap;
    });

    if (id === 'dark') d1Foot(ctx, W, H, handle, index, total);
    else if (id === 'pastel') { d2Foot(ctx, W, H, handle, index, total); d2Dots(ctx, W, index, total, H - 152); }
    else if (id === 'neon') d3Foot(ctx, W, H, handle, index, total);
    else if (id === 'minimal') d4Foot(ctx, W, H, handle, index, total);
    else d5Foot(ctx, W, H, handle, index, total);
  }

  /* =====================================================================
     registry + public render
     ===================================================================== */
  const THEMES = {
    dark: {
      id: 'dark', name: '다크 속보형', short: '다크 속보', tag: '속보 · 이슈',
      swatch: ['#0B0B10', '#FF2D2D', '#F2F2F5'], draw: drawDark
    },
    pastel: {
      id: 'pastel', name: '파스텔 매거진형', short: '파스텔 매거진', tag: '감성 · 라이프',
      swatch: ['#FBF3EE', '#D07E68', '#3B2A2C'], draw: drawPastel
    },
    neon: {
      id: 'neon', name: '네온 숏폼형', short: '네온 숏폼', tag: '쇼츠 · 트렌드',
      swatch: ['#08060F', '#00E5FF', '#FF2E9A'], draw: drawNeon
    },
    minimal: {
      id: 'minimal', name: '미니멀 화이트형', short: '미니멀 화이트', tag: '브랜드 · 정보',
      swatch: ['#FFFFFF', '#FF4D2E', '#141414'], draw: drawMinimal
    },
    news: {
      id: 'news', name: '경제 신문형', short: '경제 신문', tag: '경제 · 리서치',
      swatch: ['#F7F5EE', '#0B5D3B', '#161616'], draw: drawNews
    }
  };

  function dims(ratio) {
    return ratio === '9:16' ? { W: 1080, H: 1920 } : { W: 1080, H: 1350 };
  }

  function renderCard(canvas, opts) {
    const { W, H } = dims(opts.ratio);
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.clearRect(0, 0, W, H);
    const theme = THEMES[opts.theme] || THEMES.dark;
    ctx.save();
    const info = {
      W, H, card: opts.card, index: opts.index, total: opts.total,
      handle: opts.handle || '@your_id', ratio: opts.ratio,
      theme: theme.id, photo: opts.photo || null
    };
    if (opts.card && opts.card.type === 'summary') drawSummary(ctx, info);
    else theme.draw(ctx, info);
    ctx.restore();
    return { W, H };
  }

  global.CardNewsRender = { renderCard, THEMES, dims, SANS, SERIF, drawSummary };
})(window);
