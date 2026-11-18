// Menu, copy button, the hero animation and the feature tiles. Every page reads fine without
// this file; with reduced motion, everything is shown in its final state.
(function () {
  var root = document.documentElement;
  var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
  var SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
  var ROW = 66;

  function $(s, el) { return (el || document).querySelector(s); }
  function $$(s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function anim(el, frames, opts) {
    if (!el || !el.animate) return Promise.resolve();
    var a = el.animate(frames, opts);
    return a.finished.catch(function () {});
  }

  document.addEventListener('DOMContentLoaded', function () {
    menu();
    copy();
    tiles();
    hero();
  });

  function menu() {
    var btn = $('.menu-btn');
    if (!btn) return;
    function close() { root.classList.remove('menu-open'); btn.setAttribute('aria-expanded', 'false'); }
    btn.addEventListener('click', function () {
      var open = !root.classList.contains('menu-open');
      root.classList.toggle('menu-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    $$('#site-nav a').forEach(function (a) { a.addEventListener('click', close); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && root.classList.contains('menu-open')) { close(); btn.focus(); }
    });
  }

  function copy() {
    var btn = $('.term .copy');
    if (!btn || !navigator.clipboard) return;
    btn.hidden = false;
    btn.addEventListener('click', function () {
      var lines = $$('.term .ln').filter(function (l) { return !l.classList.contains('c'); }).map(function (l) {
        return l.textContent.replace(/^\$\s*/, '').replace(/\s+#.*$/, '');
      });
      navigator.clipboard.writeText(lines.join('\n')).then(function () {
        btn.textContent = 'Copied';
        setTimeout(function () { btn.textContent = 'Copy'; }, 1600);
      }, function () { btn.textContent = 'Copy failed'; });
    });
  }

  // Each tile plays its story once when it comes into view, and again on hover or focus.
  function tiles() {
    var els = $$('.tile, .play-on-view, .gone');
    if (still || !('IntersectionObserver' in window)) { els.forEach(function (t) { t.classList.add('play'); }); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('play'); io.unobserve(e.target); }
      });
    }, { threshold: 0.45 });
    els.forEach(function (t) {
      io.observe(t);
      if (!t.classList.contains('tile')) return;
      var last = 0;
      function replay() {
        var now = Date.now();
        if (now - last < 2600 || !t.classList.contains('play')) return;
        last = now;
        t.classList.remove('play');
        void t.offsetWidth;
        t.classList.add('play');
      }
      t.addEventListener('pointerenter', replay);
      t.addEventListener('focus', replay);
    });
  }

  // ---------- Hero: mail from four accounts lands in one inbox ----------
  var FIRST = [
    { src: 3, av: 'KS', from: 'Kenji Sato', subj: 'Train tickets for Friday', time: '08:02' },
    { src: 2, av: 'LM', from: 'Léa Martin', subj: 'Minutes from Monday', time: '08:15' },
    { src: 1, av: 'TW', from: 'Tomás Weber', subj: 'Design review, Thursday 14:00', time: '09:10', tag: 'cal' },
    { src: 0, av: 'AR', from: 'Ana Ribeiro', subj: 'Signed lease for the Lisbon office', time: '09:42', tag: 'enc' }
  ];
  var MORE = [
    { src: 1, av: 'NB', from: 'Nina Berg', subj: 'Photos from the weekend' },
    { src: 3, av: 'IT', from: 'IT desk', subj: 'Maintenance tonight at 22:00' },
    { src: 0, av: 'MD', from: 'Marc Dubois', subj: 'Re: Lisbon trip', tag: 'enc' },
    { src: 2, av: 'OS', from: 'Olivia Stone', subj: 'Quarterly numbers', tag: 'cal' },
    { src: 1, av: 'JP', from: 'Jonas Peters', subj: 'Can we move our call?' },
    { src: 3, av: 'HR', from: 'People team', subj: 'Holiday calendar for next year', tag: 'cal' }
  ];
  var LOCK = '<svg class="lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path class="shackle" d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

  function rowHTML(m) {
    var tag = m.tag === 'enc' ? '<span class="tag enc">' + LOCK + 'Encrypted</span>'
      : m.tag === 'cal' ? '<span class="tag"><svg><use href="#i-cal"/></svg>Invitation</span>' : '';
    return '<span class="av">' + m.av + '</span><span class="from">' + m.from + '</span><span class="time">' + m.time +
      '</span><span class="subj">' + tag + '<span>' + m.subj + '</span></span>';
  }
  function makeRow(m) {
    var r = document.createElement('div');
    r.className = 'row a' + (m.src + 1);
    r.innerHTML = rowHTML(m);
    return r;
  }

  function hero() {
    var stage = $('.stage');
    if (!stage) return;
    var rowsBox = $('.rows', stage), count = $('.inbox .count', stage), svg = $('.wires', stage);
    var srcs = $$('.src', stage), inbox = $('.inbox', stage);
    var rows = [], total = 0, clock = 9 * 60 + 42;

    function capacity() { return Math.max(1, Math.floor(rowsBox.clientHeight / ROW)); }
    function place(r, i) { r.style.transform = 'translateY(' + i * ROW + 'px)'; }

    // Final frame: used for reduced motion and as the starting point of the idle loop.
    function settle() {
      rowsBox.innerHTML = ''; rows = [];
      FIRST.slice().reverse().forEach(function (m, i) { var r = makeRow(m); place(r, i); rowsBox.appendChild(r); rows.push(r); });
      count.textContent = String(FIRST.length);
      srcs.forEach(function (s, i) { $('small', s).textContent = String(FIRST.filter(function (m) { return m.src === i; }).length); });
      total = FIRST.length;
    }

    if (still || !Element.prototype.animate) { settle(); return; }

    // Wires from each account to the top of the list, recomputed when the layout changes.
    var paths = [];
    function wires() {
      var sr = stage.getBoundingClientRect(), ir = inbox.getBoundingClientRect();
      var stacked = ir.top > srcs[srcs.length - 1].getBoundingClientRect().bottom - 1;
      svg.setAttribute('viewBox', '0 0 ' + sr.width + ' ' + sr.height);
      svg.innerHTML = '';
      paths = srcs.map(function (s) {
        var r = s.getBoundingClientRect(), d, sx, sy, ex, ey;
        if (stacked) {
          sx = r.left + r.width / 2 - sr.left; sy = r.bottom - sr.top;
          ex = ir.left + ir.width / 2 - sr.left; ey = ir.top - sr.top + 8;
          d = 'M' + sx + ' ' + sy + ' C' + sx + ' ' + (sy + (ey - sy) * 0.6) + ' ' + ex + ' ' + (ey - (ey - sy) * 0.6) + ' ' + ex + ' ' + ey;
        } else {
          sx = r.right - sr.left; sy = r.top + r.height / 2 - sr.top;
          ex = ir.left - sr.left + 6; ey = ir.top - sr.top + 52 + ROW / 2;
          var dx = (ex - sx) * 0.55;
          d = 'M' + sx + ' ' + sy + ' C' + (sx + dx) + ' ' + sy + ' ' + (ex - dx) + ' ' + ey + ' ' + ex + ' ' + ey;
        }
        var base = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        base.setAttribute('d', d);
        var hot = base.cloneNode();
        hot.setAttribute('class', 'hot');
        hot.style.stroke = getComputedStyle(s).getPropertyValue('--acc');
        svg.appendChild(base); svg.appendChild(hot);
        return { base: base, hot: hot };
      });
    }

    function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

    function fly(m) {
      var p = paths[m.src];
      var env = document.createElement('div');
      env.className = 'env a' + (m.src + 1);
      env.innerHTML = '<svg viewBox="0 0 30 30"><use href="#i-env"/></svg>';
      stage.appendChild(env);
      var len = p.base.getTotalLength(), frames = [], n = 28;
      var a0 = p.base.getPointAtLength(0), a1 = p.base.getPointAtLength(len);
      var main = Math.atan2(a1.y - a0.y, a1.x - a0.x) * 180 / Math.PI;
      for (var i = 0; i <= n; i++) {
        var t = i / n, pt = p.base.getPointAtLength(len * ease(t));
        var ahead = p.base.getPointAtLength(Math.min(len, len * ease(t) + 4));
        var ang = Math.atan2(ahead.y - pt.y, ahead.x - pt.x) * 180 / Math.PI;
        var dev = ((ang - main + 540) % 360) - 180;
        var tilt = Math.max(-22, Math.min(22, dev * 0.6));
        var s = t < 0.12 ? 0.6 + t / 0.12 * 0.4 : t > 0.9 ? 1 - (t - 0.9) / 0.1 * 0.45 : 1;
        frames.push({ transform: 'translate(' + pt.x + 'px,' + pt.y + 'px) rotate(' + tilt + 'deg) scale(' + s + ')', opacity: t < 0.08 ? t / 0.08 : t > 0.94 ? 0 : 1 });
      }
      anim(p.hot, [{ opacity: 0 }, { opacity: 0.9, offset: 0.3 }, { opacity: 0 }], { duration: 1100 });
      var src = srcs[m.src];
      anim(src, [{ transform: 'scale(1)' }, { transform: 'scale(0.96)' }, { transform: 'scale(1)' }], { duration: 300, easing: EASE });
      $('small', src).textContent = String(+$('small', src).textContent + 1);
      return anim(env, frames, { duration: 1000, easing: 'linear' }).then(function () { env.remove(); land(m); });
    }

    var slot = $('.slot', stage);
    function land(m) {
      if (slot) {
        slot.style.setProperty('--acc', getComputedStyle(srcs[m.src]).getPropertyValue('--acc'));
        anim(slot, [{ opacity: 0, transform: 'scaleX(0.2)' }, { opacity: 1, transform: 'scaleX(1)', offset: 0.3 }, { opacity: 0, transform: 'scaleX(1.4)' }], { duration: 700, easing: EASE });
      }
      var r = makeRow(m);
      r.classList.add('new');
      r.style.opacity = '0';
      r.style.transform = 'translateY(' + -ROW + 'px)';
      rowsBox.insertBefore(r, rowsBox.firstChild);
      rows.unshift(r);
      var cap = capacity();
      rows.forEach(function (row, i) {
        if (row === r) return;
        row.classList.remove('new');
        anim(row, [{ transform: 'translateY(' + (i - 1) * ROW + 'px)' }, { transform: 'translateY(' + i * ROW + 'px)' }], { duration: 600, easing: EASE });
        place(row, i);
      });
      anim(r, [{ transform: 'translateY(' + -ROW + 'px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 650, easing: EASE });
      r.style.opacity = ''; place(r, 0);
      while (rows.length > cap + 1) rows.pop().remove();
      if (rows.length > cap) {
        var gone = rows[rows.length - 1];
        anim(gone, [{ opacity: 1 }, { opacity: 0 }], { duration: 400 }).then(function () {
          if (rows.indexOf(gone) >= cap) { gone.remove(); rows.splice(rows.indexOf(gone), 1); }
        });
      }
      total += 1;
      count.textContent = String(total);
      anim(count, [{ transform: 'scale(1)' }, { transform: 'scale(1.3)' }, { transform: 'scale(1)' }], { duration: 420, easing: SPRING });
      if (m.tag === 'enc') seal(r);
    }

    // The lock closes on an encrypted message, with a green ring.
    function seal(r) {
      var tag = $('.tag.enc', r), shackle = $('.shackle', r);
      tag.style.opacity = '0';
      return wait(450).then(function () {
        tag.style.opacity = '';
        anim(tag, [{ opacity: 0, transform: 'scale(0.6)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 450, easing: SPRING });
        anim(shackle, [{ transform: 'translateY(-4px)' }, { transform: 'translateY(-4px)', offset: 0.4 }, { transform: 'translateY(0)' }], { duration: 700, easing: SPRING });
        var wash = document.createElement('span');
        wash.className = 'wash';
        r.appendChild(wash);
        anim(wash, [{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }], { duration: 1400, easing: 'ease-out' }).then(function () { wash.remove(); });
        var sr = stage.getBoundingClientRect(), tr = tag.getBoundingClientRect();
        var ring = document.createElement('span');
        ring.className = 'ring';
        ring.style.left = (tr.left + 12 - sr.left) + 'px';
        ring.style.top = (tr.top + tr.height / 2 - sr.top) + 'px';
        stage.appendChild(ring);
        return wait(300).then(function () {
          return anim(ring, [{ opacity: 0.9, transform: 'scale(0.3)' }, { opacity: 0, transform: 'scale(1.6)' }], { duration: 800, easing: EASE });
        }).then(function () { ring.remove(); });
      });
    }

    // Intro
    rowsBox.innerHTML = '';
    count.textContent = '0';
    srcs.forEach(function (s) { $('small', s).textContent = '0'; });
    var head = $$('.hero h1 .ln > span');
    head.forEach(function (el, i) {
      anim(el, [{ transform: 'translateY(105%)' }, { transform: 'translateY(0)' }], { duration: 1000, delay: 80 + i * 130, easing: EASE, fill: 'both' });
    });
    [$('.hero .status-row'), $('.hero .lede'), $('.hero .cta')].forEach(function (el, i) {
      anim(el, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 800, delay: 420 + i * 90, easing: EASE, fill: 'both' });
    });

    var visible = true;
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (e) { visible = e[0].isIntersecting; }, { threshold: 0.2 }).observe(stage);
    }

    wait(650).then(function () {
      wires();
      anim(svg, [{ opacity: 0 }, { opacity: 1 }], { duration: 700, fill: 'both' });
      srcs.forEach(function (s, i) {
        anim(s, [{ opacity: 0, transform: 'translateX(-14px)' }, { opacity: 1, transform: 'none' }], { duration: 600, delay: i * 80, easing: EASE, fill: 'both' });
      });
      return anim(inbox, [{ opacity: 0, transform: 'translateY(16px) scale(0.98)' }, { opacity: 1, transform: 'none' }], { duration: 800, delay: 120, easing: EASE, fill: 'both' });
    }).then(function () {
      var chain = Promise.resolve();
      FIRST.forEach(function (m, i) {
        chain = chain.then(function () { fly(m); return wait(i === FIRST.length - 1 ? 1000 : 480); });
      });
      return chain;
    }).then(function () { return wait(1800); }).then(loop);

    var k = 0;
    function loop() {
      if (visible && !document.hidden) {
        var m = MORE[k % MORE.length];
        clock += 7 + (k * 5) % 11;
        m.time = String(Math.floor(clock / 60) % 24).padStart(2, '0') + ':' + String(clock % 60).padStart(2, '0');
        k += 1;
        fly(m);
      }
      setTimeout(loop, 3400);
    }

    var t;
    window.addEventListener('resize', function () {
      clearTimeout(t);
      t = setTimeout(function () {
        wires();
        var cap = capacity();
        rows.forEach(function (r, i) { place(r, i); r.style.opacity = i < cap ? '' : '0'; });
      }, 120);
    });
  }
})();
