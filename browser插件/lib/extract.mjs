// In-page content extraction: readability-style main-content detection + Markdown conversion.
//
// IMPORTANT: `extractPage` is serialized with Function.prototype.toString and injected into the
// page, so it MUST be fully self-contained -- no imports, no closure variables, no outer refs.

export function extractPage(opts) {
  opts = opts || {};
  var maxLinks = opts.maxLinks || 500;
  var includeLinks = opts.includeLinks !== false;

  var BAD_SEL =
    'script,style,noscript,iframe,svg,canvas,form,input,button,select,textarea,template,link,meta,object,embed,audio,video,nav,footer,header,aside,[aria-hidden="true"]';
  var BAD_RE =
    /(^|[-_ ])(nav|navbar|navigation|menu|sidebar|side-bar|footer|header|comment|comments|ad|ads|advert|adsbygoogle|banner|promo|share|sharing|social|related|recommend|breadcrumb|pagination|pager|popup|modal|login|signin|signup|subscribe|newsletter|cookie|toolbar|widget|reward|app-download|openapp|qrcode|download-app|backtop|gotop)([-_ ]|$)/i;
  var INLINE = {
    a: 1, strong: 1, b: 1, em: 1, i: 1, code: 1, span: 1, br: 1, img: 1, mark: 1, small: 1,
    sub: 1, sup: 1, u: 1, abbr: 1, time: 1, del: 1, s: 1, font: 1, label: 1, kbd: 1, samp: 1,
    var: 1, cite: 1, q: 1, bdi: 1, bdo: 1, wbr: 1, ins: 1, ruby: 1, rt: 1, rp: 1, big: 1, tt: 1,
  };

  function absUrl(u) {
    if (!u) return '';
    try {
      return new URL(u, document.baseURI || location.href).href;
    } catch (e) {
      return '';
    }
  }
  function collapse(s) {
    return String(s == null ? '' : s).replace(/[ \t\r\n\u00a0\u3000]+/g, ' ');
  }
  function liveVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    var cs = window.getComputedStyle(el);
    if (!cs) return true;
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    return true;
  }
  function visibleText(el) {
    var t = '';
    try {
      t = el.innerText || '';
    } catch (e) {
      t = '';
    }
    if (!t) t = el.textContent || '';
    return collapse(t).trim();
  }
  function imgSrc(el) {
    var attrs = ['currentSrc', 'src', 'data-src', 'data-original', 'data-actualsrc', 'data-lazy-src', 'data-echo', 'data-original-src'];
    for (var i = 0; i < attrs.length; i++) {
      var v = attrs[i] === 'currentSrc' ? el.currentSrc : el.getAttribute(attrs[i]);
      if (v && !/^data:/i.test(v)) {
        var abs = absUrl(v);
        if (abs) return abs;
      }
    }
    return '';
  }
  function linkDensity(el) {
    var total = visibleText(el).length;
    if (!total) return 0;
    var anchors = el.querySelectorAll('a');
    var linked = 0;
    for (var i = 0; i < anchors.length; i++) linked += collapse(anchors[i].textContent).length;
    return Math.min(linked / total, 1);
  }

  // ---- 1. score candidate containers -------------------------------------
  var scores = new Map();
  var blocks = document.querySelectorAll('p,pre,blockquote,li,h2,h3,h4,td,figcaption');
  for (var i = 0; i < blocks.length; i++) {
    var el = blocks[i];
    if (!liveVisible(el)) continue;
    var t = visibleText(el);
    if (t.length < 20) continue;
    var add = Math.min(t.length, 800) + (el.tagName === 'P' ? 30 : 0);
    var p = el.parentElement;
    if (!p) continue;
    scores.set(p, (scores.get(p) || 0) + add);
    var gp = p.parentElement;
    if (gp) scores.set(gp, (scores.get(gp) || 0) + add * 0.4);
    var ggp = gp && gp.parentElement;
    if (ggp) scores.set(ggp, (scores.get(ggp) || 0) + add * 0.15);
  }

  var best = null;
  var bestScore = -1;
  scores.forEach(function (score, node) {
    var txt = visibleText(node).length;
    if (txt < 140) return;
    var adjusted = score * (1 - linkDensity(node));
    // Mild preference for semantically meaningful containers.
    var tag = node.tagName ? node.tagName.toLowerCase() : '';
    if (tag === 'article' || tag === 'main' || tag === 'section') adjusted *= 1.15;
    var role = node.getAttribute && node.getAttribute('role');
    if (role === 'main' || role === 'article') adjusted *= 1.15;
    if (adjusted > bestScore) {
      bestScore = adjusted;
      best = node;
    }
  });

  // Prefer an explicit article container when it is comparably substantial.
  var explicitSel =
    'article,[role="article"],main,[role="main"],.RichText,.Post-RichText,#js_content,.article-content,.post-content,.markdown-body,.entry-content,.artical-content';
  var explicitNodes = document.querySelectorAll(explicitSel);
  for (var e = 0; e < explicitNodes.length; e++) {
    var cand = explicitNodes[e];
    if (!liveVisible(cand)) continue;
    var candLen = visibleText(cand).length;
    if (candLen < 200) continue;
    if (candLen < 0.5 * (best ? visibleText(best).length : 0)) continue;
    if (linkDensity(cand) > 0.45) continue;
    best = cand;
    break;
  }

  var fallbackUsed = false;
  if (!best || visibleText(best).length < 200) {
    var bodyLen = visibleText(document.body).length;
    if (!best || bodyLen > visibleText(best).length) {
      best = document.body;
      fallbackUsed = true;
    }
  }

  // ---- 2. clean a clone of the chosen container --------------------------
  var node = best.cloneNode(true);

  function stripNoise(root) {
    var junk = root.querySelectorAll(BAD_SEL);
    for (var j = 0; j < junk.length; j++) {
      var n = junk[j];
      if (n.parentNode) n.parentNode.removeChild(n);
    }
    var all = root.querySelectorAll('*');
    var doomed = [];
    for (var k = 0; k < all.length; k++) {
      var el2 = all[k];
      var sig = (el2.className && String(el2.className)) + ' ' + (el2.id || '');
      if (typeof sig === 'string' && BAD_RE.test(sig)) {
        doomed.push(el2);
        continue;
      }
      var txtLen = collapse(el2.textContent).length;
      if (txtLen === 0 && !el2.querySelector('img,video,audio')) {
        doomed.push(el2);
        continue;
      }
      if (txtLen < 250 && linkDensity(el2) > 0.7) doomed.push(el2);
    }
    for (var d = 0; d < doomed.length; d++) {
      var dn = doomed[d];
      if (dn.parentNode) dn.parentNode.removeChild(dn);
    }
  }
  stripNoise(node);

  // ---- 3. Markdown conversion -------------------------------------------
  function mdInline(el) {
    var out = '';
    var kids = el.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c.nodeType === 3) {
        out += collapse(c.textContent);
        continue;
      }
      if (c.nodeType !== 1) continue;
      var tag = c.tagName.toLowerCase();
      if (tag === 'br') {
        out += ' ';
        continue;
      }
      if (tag === 'img') {
        var s = imgSrc(c);
        if (s) out += '![' + collapse(c.getAttribute('alt') || '') + '](' + s + ')';
        continue;
      }
      if (tag === 'a') {
        var href = absUrl(c.getAttribute('href'));
        var label = mdInline(c).replace(/\s+/g, ' ').trim();
        if (!label) continue;
        out += href && /^https?:/i.test(href) ? '[' + label + '](' + href + ')' : label;
        continue;
      }
      if (tag === 'code') {
        var ct = collapse(c.textContent).trim();
        if (ct) out += '`' + ct + '`';
        continue;
      }
      if (tag === 'strong' || tag === 'b') {
        var b = mdInline(c).trim();
        if (b) out += '**' + b + '**';
        continue;
      }
      if (tag === 'em' || tag === 'i') {
        var it = mdInline(c).trim();
        if (it) out += '*' + it + '*';
        continue;
      }
      if (tag === 'del' || tag === 's') {
        var dt = mdInline(c).trim();
        if (dt) out += '~~' + dt + '~~';
        continue;
      }
      out += mdInline(c);
    }
    return out;
  }

  function blockChildren(el, indent, out) {
    var kids = el.childNodes;
    var buffer = '';
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c.nodeType === 3) {
        buffer += collapse(c.textContent);
        continue;
      }
      if (c.nodeType !== 1) continue;
      var tag = c.tagName.toLowerCase();
      if (INLINE[tag]) {
        buffer += mdInline(c);
        continue;
      }
      if (buffer.trim()) out.push('\n' + buffer.trim() + '\n');
      buffer = '';
      mdBlock(c, indent, out);
    }
    if (buffer.trim()) out.push('\n' + buffer.trim() + '\n');
  }

  function listItemsDirect(el) {
    var res = [];
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if (c.tagName && (c.tagName.toLowerCase() === 'li' || c.tagName.toLowerCase() === 'dt' || c.tagName.toLowerCase() === 'dd'))
        res.push(c);
    }
    return res;
  }

  function mdBlock(el, indent, out) {
    var tag = el.tagName ? el.tagName.toLowerCase() : '';
    var pad = new Array(indent + 1).join(' ');

    if (/^h[1-6]$/.test(tag)) {
      var lvl = Number(tag.charAt(1));
      var ht = mdInline(el).replace(/\s+/g, ' ').trim();
      if (ht) out.push('\n' + new Array(lvl + 1).join('#') + ' ' + ht + '\n');
      return;
    }
    if (tag === 'p') {
      var pt = mdInline(el).replace(/\s+/g, ' ').trim();
      if (pt) out.push('\n' + pt + '\n');
      return;
    }
    if (tag === 'br') {
      out.push('\n');
      return;
    }
    if (tag === 'hr') {
      out.push('\n---\n');
      return;
    }
    if (tag === 'pre') {
      var code = el.textContent.replace(/^\n+/, '').replace(/\n+$/, '');
      var codeEl = el.querySelector('code');
      var lang = '';
      if (codeEl) {
        var m = /(?:language|lang)-([\w+#.-]+)/.exec(String(codeEl.className || ''));
        if (m) lang = m[1];
      }
      if (code.trim()) out.push('\n```' + lang + '\n' + code + '\n```\n');
      return;
    }
    if (tag === 'blockquote') {
      var sub = [];
      blockChildren(el, indent, sub);
      var body = sub.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      if (body) {
        out.push('\n' + body.split('\n').map(function (l) { return '> ' + l; }).join('\n') + '\n');
      }
      return;
    }
    if (tag === 'ul' || tag === 'ol') {
      var items = listItemsDirect(el);
      out.push('\n');
      for (var i = 0; i < items.length; i++) {
        var li = items[i];
        var clone = li.cloneNode(true);
        var nested = clone.querySelectorAll('ul,ol');
        for (var s = 0; s < nested.length; s++) {
          if (nested[s].parentNode) nested[s].parentNode.removeChild(nested[s]);
        }
        var label = mdInline(clone).replace(/\s+/g, ' ').trim();
        var marker = tag === 'ol' ? i + 1 + '. ' : '- ';
        if (label) out.push(pad + marker + label + '\n');
        for (var c2 = 0; c2 < li.children.length; c2++) {
          var ch = li.children[c2];
          var ctag = ch.tagName ? ch.tagName.toLowerCase() : '';
          if (ctag === 'ul' || ctag === 'ol') mdBlock(ch, indent + 2, out);
        }
      }
      return;
    }
    if (tag === 'dl') {
      blockChildren(el, indent, out);
      return;
    }
    if (tag === 'dt') {
      var dtt = mdInline(el).trim();
      if (dtt) out.push('\n**' + dtt + '**\n');
      return;
    }
    if (tag === 'dd') {
      var ddt = mdInline(el).trim();
      if (ddt) out.push(pad + ': ' + ddt + '\n');
      return;
    }
    if (tag === 'table') {
      var rows = el.querySelectorAll('tr');
      var lines = [];
      for (var r = 0; r < rows.length; r++) {
        var cells = rows[r].querySelectorAll('th,td');
        var parts = [];
        for (var c3 = 0; c3 < cells.length; c3++) {
          var v = mdInline(cells[c3]).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
          parts.push(v || ' ');
        }
        if (!parts.length) continue;
        if (lines.length === 0 && rows[r].querySelector('th')) {
          lines.push('| ' + parts.join(' | ') + ' |');
          lines.push('|' + parts.map(function () { return ' --- '; }).join('|') + '|');
        }
        lines.push('| ' + parts.join(' | ') + ' |');
      }
      if (lines.length) out.push('\n' + lines.join('\n') + '\n');
      return;
    }
    if (tag === 'img') {
      var is = imgSrc(el);
      if (is) out.push('\n![' + collapse(el.getAttribute('alt') || '') + '](' + is + ')\n');
      return;
    }
    if (tag === 'figcaption') {
      var cap = mdInline(el).replace(/\s+/g, ' ').trim();
      if (cap) out.push('\n*' + cap + '*\n');
      return;
    }
    if (tag === 'li') {
      blockChildren(el, indent, out);
      return;
    }
    blockChildren(el, indent, out);
  }

  var out = [];
  blockChildren(node, 0, out);
  var markdown = out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // ---- 4. metadata + links ----------------------------------------------
  function meta(names) {
    for (var i = 0; i < names.length; i++) {
      var sel = 'meta[name="' + names[i] + '"],meta[property="' + names[i] + '"]';
      var m = document.querySelector(sel);
      if (m && m.getAttribute('content')) return m.getAttribute('content').trim();
    }
    return '';
  }

  var links = [];
  if (includeLinks) {
    var seen = {};
    var anchors = document.querySelectorAll('a[href]');
    for (var a = 0; a < anchors.length && links.length < maxLinks; a++) {
      var href = absUrl(anchors[a].getAttribute('href'));
      if (!href || !/^https?:/i.test(href)) continue;
      if (seen[href]) continue;
      seen[href] = 1;
      links.push({ text: collapse(anchors[a].innerText || anchors[a].textContent).trim().slice(0, 120), href: href });
    }
  }

  var pageText = visibleText(document.body);
  var hints = [];
  var wallPatterns = [
    [/请您登录|请先登录|立即登录|登录后查看|登录知乎|登录后你可以|登录以查看|sign in to continue/i, 'login-wall'],
    [/verify you are human|just a moment|checking your browser|cf-challenge/i, 'bot-challenge'],
    [/安全验证|滑动验证|请输入验证码|人机验证/, 'captcha'],
    [/环境异常|当前环境异常|访问受限|请求被拒绝/, 'blocked-environment'],
  ];
  for (var w = 0; w < wallPatterns.length; w++) {
    if (wallPatterns[w][0].test(pageText)) hints.push(wallPatterns[w][1]);
  }
  // The redirect target is often the real tell: a short page parked on a signin/unhuman URL.
  var urlHint = /(?:unhuman|\/signin|\/login|passport|verify|captcha|challenge|account\/unhuman)/i;
  if (urlHint.test(location.href) && pageText.length < 3000) {
    if (hints.indexOf('login-wall') < 0) hints.push('login-wall');
    hints.push('redirected(url)');
  }
  if (pageText.length < 60 && hints.length === 0) hints.push('little-text');

  var canonical = document.querySelector('link[rel="canonical"]');
  var plain = visibleText(best);

  return {
    ok: true,
    url: location.href,
    title: (document.title || '').trim(),
    canonical: canonical ? absUrl(canonical.getAttribute('href')) : '',
    byline: meta(['author', 'article:author', 'og:article:author', 'twitter:creator']),
    publishedTime: meta(['article:published_time', 'datePublished', 'pubdate', 'publishdate', 'og:updated_time']),
    description: meta(['description', 'og:description', 'twitter:description']),
    siteName: meta(['og:site_name', 'application-name']),
    image: meta(['og:image', 'twitter:image']),
    container: fallbackUsed ? 'body(fallback)' : best.tagName.toLowerCase() + (best.id ? '#' + best.id : ''),
    wordCount: markdown.replace(/\s/g, '').length,
    textLength: plain.length,
    hints: hints,
    markdown: markdown,
    text: plain,
    links: links,
  };
}

export function extractorExpression(opts = {}) {
  return `(${extractPage.toString()})(${JSON.stringify(opts)})`;
}
