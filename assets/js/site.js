// Small progressive enhancements. Every page works without this file.
(function () {
  var root = document.documentElement;

  // Theme toggle (the saved choice is applied early by an inline script in <head>)
  var themeBtn = document.getElementById('theme-toggle');
  function isDark() {
    var t = root.getAttribute('data-theme');
    return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function labelTheme() { if (themeBtn) themeBtn.textContent = isDark() ? 'Light' : 'Dark'; }
  if (themeBtn) {
    labelTheme();
    themeBtn.addEventListener('click', function () {
      var next = isDark() ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('theme', next); } catch (e) {}
      labelTheme();
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', labelTheme);
  }

  // Mobile menu
  var menuBtn = document.getElementById('menu-btn'), nav = document.getElementById('site-nav');
  if (menuBtn && nav) {
    menuBtn.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      menuBtn.setAttribute('aria-expanded', String(open));
      menuBtn.textContent = open ? 'Close' : 'Menu';
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && nav.classList.contains('open')) { menuBtn.click(); menuBtn.focus(); }
    });
  }

  // Copy buttons
  document.querySelectorAll('[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () {
      var el = document.getElementById(b.getAttribute('data-copy'));
      var text = el.textContent.trim();
      function selectIt() { var r = document.createRange(); r.selectNodeContents(el); var s = getSelection(); s.removeAllRanges(); s.addRange(r); }
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(function () {
          b.textContent = 'Copied';
          setTimeout(function () { b.textContent = 'Copy'; }, 1800);
        }, selectIt);
      } else { selectIt(); }
    });
  });

  // Die floorplan: show where each block's skills were used
  var cap = document.getElementById('chip-cap');
  var blocks = document.querySelectorAll('.blk');
  blocks.forEach(function (blk) {
    function on() {
      blocks.forEach(function (q) { q.classList.remove('on'); });
      blk.classList.add('on');
      cap.textContent = '';
      var b = document.createElement('b');
      b.textContent = blk.dataset.label + ', ' + blk.dataset.name + '.';
      cap.appendChild(b);
      cap.appendChild(document.createTextNode(' Used in ' + blk.dataset.use + '.'));
    }
    blk.addEventListener('mouseenter', on);
    blk.addEventListener('focus', on);
    blk.addEventListener('click', on);
  });

  // "Contact me" links: bring the contact footer to the middle of the screen and briefly highlight it
  var footer = document.getElementById('contact');
  if (footer) {
    document.querySelectorAll('a[href="#contact"]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        footer.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
        history.replaceState(null, '', '#contact');
        var box = footer.querySelector('.contact');
        if (box) { box.classList.add('flash'); setTimeout(function () { box.classList.remove('flash'); }, 1600); }
        var mail = document.getElementById('email-text');
        if (mail) setTimeout(function () { mail.focus({ preventScroll: true }); }, reduce ? 0 : 500);
      });
    });
  }
})();
