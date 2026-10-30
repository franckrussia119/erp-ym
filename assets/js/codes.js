/* YM-TRANSIT · articles et codes tarifaires : propositions depuis le dictionnaire pendant la saisie */
(function () {
  var timer, menu;
  function close() { if (menu) { menu.remove(); menu = null; } }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }
  function show(inp, list) {
    close();
    if (!list.length || document.activeElement !== inp) return;
    menu = document.createElement('div');
    menu.className = 'ct-menu';
    menu.innerHTML = list.map(function (c, i) {
      return '<button type="button" data-i="' + i + '"><b>' + esc(c.code) + '</b><span>' + esc(c.designation) + '</span>' + (c.usages ? '<small>' + c.usages + '×</small>' : '') + '</button>';
    }).join('');
    menu.addEventListener('mousedown', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      e.preventDefault();
      var c = list[+b.getAttribute('data-i')], line = inp.closest('[data-art-line]');
      line.querySelector('[data-ct="code"]').value = c.code;
      var des = line.querySelector('[data-ct="des"]'); if (!des.value.trim()) des.value = c.designation;
      close();
    });
    inp.parentNode.appendChild(menu);
  }
  document.addEventListener('input', function (e) {
    var inp = e.target.closest && e.target.closest('[data-ct]'); if (!inp) return;
    clearTimeout(timer);
    var q = inp.value.trim(); if (q.length < 2) return close();
    timer = setTimeout(function () {
      fetch('/api/codes-tarifaires?q=' + encodeURIComponent(q), { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : []; }).then(function (l) { show(inp, l); }).catch(close);
    }, 180);
  });
  document.addEventListener('focusout', function (e) { if (e.target.closest && e.target.closest('[data-ct]')) setTimeout(close, 150); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  document.addEventListener('click', function (e) {
    var add = e.target.closest('[data-art-add]');
    if (add) {
      var box = add.closest('.col-12').querySelector('[data-art-lines]'), first = box.querySelector('[data-art-line]'), row = first.cloneNode(true);
      row.querySelectorAll('input').forEach(function (i) { i.value = ''; });
      box.appendChild(row); row.querySelector('input').focus(); return;
    }
    var del = e.target.closest('[data-art-del]');
    if (del) {
      var lines = del.closest('[data-art-lines]'), l = del.closest('[data-art-line]');
      if (lines.querySelectorAll('[data-art-line]').length > 1) l.remove(); else l.querySelectorAll('input').forEach(function (i) { i.value = ''; });
    }
  });
})();
