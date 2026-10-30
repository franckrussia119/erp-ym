/* YM-TRANSIT · discussion sur une fiche (demande, bon, client) : messages, pièces jointes, mentions @ */
(function () {
  var membres = null;
  function getMembres() {
    if (membres) return Promise.resolve(membres);
    return fetch('/fil-membres').then(function (r) { return r.json(); }).then(function (j) { membres = j; return j; });
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmtTime(d) {
    d = new Date(d); var now = new Date();
    var t = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === now.toDateString() ? t : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + ' ' + t;
  }
  function size(n) { return n > 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' Mo' : Math.max(1, Math.round(n / 1024)) + ' Ko'; }
  function textHtml(t, noms) {
    var h = esc(t).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    (noms || []).forEach(function (n) { h = h.split('@' + esc(n)).join('<b class="fil-at">@' + esc(n) + '</b>'); });
    return h;
  }
  function attHtml(a) {
    if (a.kind === 'image') return '<a class="fil-img" href="' + a.url + '" target="_blank"><img src="' + a.url + '" alt="' + esc(a.name) + '" loading="lazy"></a>';
    if (a.kind === 'video') return '<video class="fil-vid" src="' + a.url + '" controls preload="metadata"></video>';
    if (a.kind === 'audio') return '<audio src="' + a.url + '" controls preload="none"></audio>';
    return '<a class="fil-file" href="' + a.url + '" target="_blank"><i class="bi ' + (a.kind === 'pdf' ? 'bi-file-earmark-pdf' : 'bi-file-earmark') + '"></i><span>' + esc(a.name) + '<small>' + size(a.size || 0) + '</small></span></a>';
  }

  function init(box) {
    if (box._fil) return; box._fil = true;
    var key = box.dataset.fil.split(':'), base = '/fil/' + key[0] + '/' + key[1];
    var list = box.querySelector('[data-fil-list]'), form = box.querySelector('[data-fil-form]');
    var text = box.querySelector('[data-fil-text]'), files = box.querySelector('[data-fil-files]'), tray = box.querySelector('[data-fil-tray]');
    var pop = box.querySelector('[data-fil-mentions]'), prog = box.querySelector('[data-fil-progress]'), count = box.querySelector('[data-fil-count]');
    var picked = [], mentions = {}, sending = false;

    function render(msgs) {
      var n = msgs.filter(function (m) { return !m.deleted; }).length;
      count.textContent = n ? n + ' message' + (n > 1 ? 's' : '') : '';
      if (!msgs.length) { list.innerHTML = '<div class="fil-empty"><i class="bi bi-chat-square-text"></i>Aucun message. Posez une question, ajoutez une photo ou un document, mentionnez un collègue avec @.</div>'; return; }
      var atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
      list.innerHTML = msgs.map(function (m) {
        if (m.deleted) return '<div class="fil-msg ' + (m.mine ? 'mine' : '') + ' deleted"><div class="fil-bubble"><i class="bi bi-slash-circle me-1"></i>Message supprimé</div></div>';
        return '<div class="fil-msg ' + (m.mine ? 'mine' : '') + '" data-id="' + m.id + '">' +
          (m.mine ? '' : '<span class="fil-av">' + esc(m.initiales) + '</span>') +
          '<div class="fil-bubble">' + (m.mine ? '' : '<b class="fil-who">' + esc(m.auteur) + '</b>') +
          (m.att.length ? '<div class="fil-atts">' + m.att.map(attHtml).join('') + '</div>' : '') +
          (m.texte ? '<div class="fil-text">' + textHtml(m.texte, m.mentions) + '</div>' : '') +
          '<span class="fil-time">' + fmtTime(m.at) + (m.mine ? ' <button type="button" class="fil-del" data-fil-del="' + m.id + '" title="Supprimer pour tous"><i class="bi bi-trash3"></i></button>' : '') + '</span>' +
          '</div></div>';
      }).join('');
      if (atBottom || !box._loaded) list.scrollTop = list.scrollHeight;
      box._loaded = true;
    }
    function pull() {
      return fetch(base, { headers: { Accept: 'application/json' } }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j.messages) return;
        render(j.messages); form.hidden = !j.canWrite;
      }).catch(function () {});
    }
    box._pull = pull;
    pull();

    // Pièces jointes en attente
    function drawTray() {
      tray.hidden = !picked.length;
      tray.innerHTML = picked.map(function (f, i) { return '<span class="fil-chip"><i class="bi ' + (/^image/.test(f.type) ? 'bi-image' : /^video/.test(f.type) ? 'bi-camera-video' : 'bi-file-earmark') + '"></i>' + esc(f.name) + ' <small>' + size(f.size) + '</small><button type="button" data-fil-unpick="' + i + '">×</button></span>'; }).join('');
    }
    files.addEventListener('change', function () { for (var i = 0; i < files.files.length && picked.length < 10; i++) picked.push(files.files[i]); files.value = ''; drawTray(); });
    tray.addEventListener('click', function (e) { var b = e.target.closest('[data-fil-unpick]'); if (b) { picked.splice(+b.dataset.filUnpick, 1); drawTray(); } });

    // Mentions @
    function mentionQuery() {
      var v = text.value.slice(0, text.selectionStart), m = v.match(/(^|\s)@([\wÀ-ÿ'-]*)$/);
      return m ? m[2] : null;
    }
    text.addEventListener('input', function () {
      text.style.height = 'auto'; text.style.height = Math.min(text.scrollHeight, 140) + 'px';
      var q = mentionQuery();
      if (q === null) { pop.hidden = true; return; }
      getMembres().then(function (ms) {
        var ql = q.toLowerCase(), hits = ms.filter(function (u) { return u.nom.toLowerCase().indexOf(ql) >= 0; }).slice(0, 6);
        pop.hidden = !hits.length;
        pop.innerHTML = hits.map(function (u, i) { return '<button type="button" class="' + (i ? '' : 'on') + '" data-uid="' + u.id + '" data-nom="' + esc(u.nom) + '">' + esc(u.nom) + '</button>'; }).join('');
      });
    });
    function pick(btn) {
      var before = text.value.slice(0, text.selectionStart).replace(/@([\wÀ-ÿ'-]*)$/, '@' + btn.dataset.nom + ' ');
      text.value = before + text.value.slice(text.selectionStart);
      mentions[btn.dataset.nom] = +btn.dataset.uid; pop.hidden = true; text.focus();
      text.setSelectionRange(before.length, before.length);
    }
    pop.addEventListener('mousedown', function (e) { var b = e.target.closest('button'); if (b) { e.preventDefault(); pick(b); } });
    text.addEventListener('keydown', function (e) {
      if (!pop.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape')) {
        var bs = [].slice.call(pop.children), i = bs.findIndex(function (b) { return b.classList.contains('on'); });
        if (e.key === 'Escape') { pop.hidden = true; e.preventDefault(); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); if (bs[i]) pick(bs[i]); return; }
        e.preventDefault(); if (bs[i]) bs[i].classList.remove('on');
        i = (i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length; bs[i].classList.add('on'); return;
      }
      if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer: fine)').matches) { e.preventDefault(); send(); }
    });

    function send() {
      var t = text.value.trim();
      if (sending || (!t && !picked.length)) return;
      var ids = Object.keys(mentions).filter(function (n) { return t.indexOf('@' + n) >= 0; }).map(function (n) { return mentions[n]; });
      var fd = new FormData(); fd.append('texte', t); fd.append('mentions', JSON.stringify(ids));
      picked.forEach(function (f) { fd.append('fichiers', f); });
      sending = true; prog.hidden = !picked.length; prog.firstChild.style.width = '0';
      var x = new XMLHttpRequest(); x.open('POST', base);
      x.upload.onprogress = function (e) { if (e.lengthComputable) prog.firstChild.style.width = Math.round(e.loaded / e.total * 100) + '%'; };
      x.onload = function () {
        sending = false; prog.hidden = true;
        var j = {}; try { j = JSON.parse(x.responseText); } catch (e) {}
        if (x.status >= 400 || !j.ok) { alert(j.error || 'Envoi impossible.'); return; }
        text.value = ''; text.style.height = 'auto'; picked = []; mentions = {}; drawTray(); box._loaded = false; pull();
      };
      x.onerror = function () { sending = false; prog.hidden = true; alert('Connexion perdue : message non envoyé.'); };
      x.send(fd);
    }
    form.addEventListener('submit', function (e) { e.preventDefault(); send(); });
    list.addEventListener('click', function (e) {
      var d = e.target.closest('[data-fil-del]'); if (!d) return;
      if (!confirm('Supprimer ce message pour tout le monde ?')) return;
      fetch(base + '/' + d.dataset.filDel, { method: 'DELETE' }).then(function () { pull(); });
    });
  }

  function scan() { document.querySelectorAll('[data-fil]').forEach(init); }
  scan();
  document.addEventListener('ym:refreshed', scan);
  document.addEventListener('ym:fil', function (e) {
    var box = document.querySelector('[data-fil="' + (e.detail && e.detail.k) + '"]');
    if (box && box._pull) box._pull();
  });
})();
