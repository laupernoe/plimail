// Menu, copy buttons and the sample inbox. Every page works without this file.
document.addEventListener('DOMContentLoaded', function () {
  var root = document.documentElement;

  var menu = document.querySelector('.menu-btn');
  if (menu) {
    var close = function () { root.classList.remove('menu-open'); menu.setAttribute('aria-expanded', 'false'); };
    menu.addEventListener('click', function () {
      var open = !root.classList.contains('menu-open');
      root.classList.toggle('menu-open', open);
      menu.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.querySelectorAll('#site-nav a').forEach(function (a) { a.addEventListener('click', close); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && root.classList.contains('menu-open')) { close(); menu.focus(); } });
  }

  if (navigator.clipboard) {
    document.querySelectorAll('.code pre').forEach(function (pre) {
      if (pre.closest('details')) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'copy';
      btn.textContent = 'Copy';
      btn.addEventListener('click', function () {
        var text = Array.prototype.filter.call(pre.textContent.split('\n'), function (l) { return l.trim() && l.trim()[0] !== '#'; }).join('\n');
        navigator.clipboard.writeText(text).then(function () {
          btn.textContent = 'Copied';
          setTimeout(function () { btn.textContent = 'Copy'; }, 1600);
        }, function () { btn.textContent = 'Copy failed'; });
      });
      pre.classList.add('has-copy');
      pre.parentNode.appendChild(btn);
    });
  }

  var tabs = Array.prototype.slice.call(document.querySelectorAll('.msg[role="tab"]'));
  if (!tabs.length) return;
  var captions = document.querySelectorAll('.captions [data-for]');
  function select(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      if (on) t.classList.remove('unread');
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
    var id = tab.getAttribute('aria-controls');
    captions.forEach(function (c) { c.hidden = c.getAttribute('data-for') !== id; });
    if (focus) tab.focus();
  }
  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () { select(tab, false); });
    tab.addEventListener('keydown', function (e) {
      var next = null;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === 'Home') next = tabs[0];
      else if (e.key === 'End') next = tabs[tabs.length - 1];
      if (next) { e.preventDefault(); select(next, true); }
    });
  });
});
