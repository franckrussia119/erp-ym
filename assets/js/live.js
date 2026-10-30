/* YM-TRANSIT · mises à jour en direct.
   Le serveur annonce chaque changement (/api/live) ; la page concernée se recharge en arrière-plan
   et remplace son contenu sans perdre la position. Si l'utilisateur est en train de saisir,
   un bouton « Actualiser » apparaît au lieu de tout remplacer. */
(function () {
  var body = document.body;
  var me = parseInt(body.getAttribute('data-uid') || '0', 10);
  if (!me || !window.EventSource || !window.fetch || !window.DOMParser) return;

  var path = location.pathname;
  var m = path.match(/^\/dossiers\/(\d+)(\/|$)/);
  var dossierId = m ? parseInt(m[1], 10) : null;
  var main = function () { return document.querySelector('main.app-content'); };

  function relevant(ev) {
    if (ev.t === 'notif') return false;
    if (dossierId) return ev.d === dossierId || (ev.t === 'dossier' && ev.id === dossierId);
    if (/^\/(dashboard|mon-espace)/.test(path)) return ['dossier', 'bon', 'tache', 'caisse'].indexOf(ev.t) >= 0;
    if (/^\/dossiers\/?$|^\/dossiers\/(liste|archives)|^\/archives/.test(path)) return ev.t === 'dossier';
    if (/^\/bons|^\/depenses/.test(path)) return ev.t === 'bon' || ev.t === 'caisse';
    if (/^\/caisse/.test(path)) return ev.t === 'caisse' || ev.t === 'bon';
    if (/^\/taches/.test(path)) return ev.t === 'tache';
    if (/^\/facturation|^\/documents/.test(path)) return ev.t === 'document';
    if (/^\/rapports/.test(path)) return ev.t !== 'tache';
    return false;
  }

  /* --- saisie en cours : on ne remplace pas la page sous les doigts de l'utilisateur --- */
  var dirty = false;
  // la discussion du dossier est conservée telle quelle lors d'une mise à jour : elle ne bloque rien
  var inChat = function (el) { return !!(el && el.closest && el.closest('.ds-chat, .fil')); };
  document.addEventListener('input', function (e) { if (e.target.closest && e.target.closest('main form') && !inChat(e.target)) dirty = true; }, true);
  document.addEventListener('submit', function () { dirty = false; }, true);
  function busy() {
    if (dirty) return true;
    if (document.querySelector('.modal.show, .dropdown-menu.show, .offcanvas.show')) return true;
    var a = document.activeElement;
    return !!(a && a.closest && a.closest('main') && !inChat(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'checkbox' && a.type !== 'radio');
  }

  var pill = null;
  function showPill() {
    if (pill) return;
    pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'live-pill';
    pill.innerHTML = '<i class="bi bi-arrow-repeat"></i> Nouvelles mises à jour · Actualiser';
    pill.onclick = function () { dirty = false; refresh(true); };
    body.appendChild(pill);
  }
  function hidePill() { if (pill) { pill.remove(); pill = null; } }

  /* --- réexécution des scripts de la page après remplacement --- */
  function runScripts(root) {
    var od = document.addEventListener, ow = window.addEventListener;
    var now = function (target, type, fn) { try { fn.call(target, new Event(type)); } catch (e) { console.error(e); } };
    // les écouteurs globaux existent déjà depuis le premier chargement : on ne les double pas
    document.addEventListener = function (type, fn, o) { if (type === 'DOMContentLoaded' || type === 'readystatechange') return now(document, type, fn); };
    window.addEventListener = function (type, fn, o) { if (type === 'load' || type === 'DOMContentLoaded') return now(window, type, fn); };
    try {
      root.querySelectorAll('script').forEach(function (old) {
        // données JSON et scripts conservés (discussion) : rien à réexécuter
        if (old.hasAttribute('data-live-keep') || (old.type && !/^(text\/javascript|module|application\/javascript)$/i.test(old.type))) return;
        var s = document.createElement('script');
        if (old.src) {
          if (document.querySelector('script[src="' + old.getAttribute('src') + '"]:not([data-live-copy])')) { old.remove(); return; }
          s.src = old.src; s.setAttribute('data-live-copy', '1');
        } else {
          s.textContent = '{\n' + old.textContent + '\n}';
        }
        old.replaceWith(s);
      });
    } finally {
      document.addEventListener = od; window.addEventListener = ow;
    }
  }

  var inflight = false, again = false, lastRefresh = Date.now();
  function refresh(force) {
    if (!force && busy()) { showPill(); return; }
    if (inflight) { again = true; return; }
    inflight = true;
    var openCollapses = Array.prototype.map.call(document.querySelectorAll('main .collapse.show[id]'), function (el) { return el.id; });
    var activeTabs = Array.prototype.map.call(document.querySelectorAll('main [data-bs-toggle="tab"].active[id], main [data-bs-toggle="pill"].active[id]'), function (el) { return el.id; });
    fetch(location.href, { credentials: 'same-origin', headers: { 'X-Live-Refresh': '1' } })
      .then(function (r) {
        if (!r.ok || (r.redirected && new URL(r.url).pathname !== location.pathname)) throw new Error('nav');
        return r.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var fresh = doc.querySelector('main.app-content'), cur = main();
        if (!fresh || !cur) throw new Error('layout');
        var y = window.scrollY;
        // la discussion reste en place (saisie, défilement, focus), seul son fil est rechargé
        var oldChat = cur.querySelector('#chat'), newChat = fresh.querySelector('#chat');
        if (oldChat && newChat) {
          newChat.replaceWith(oldChat);
          ['#dchatFab', '#dchatData', 'script[data-chat]'].forEach(function (q) { var n = fresh.querySelector(q), o = cur.querySelector(q); if (n && o) n.replaceWith(o); });
          fresh.querySelectorAll('script[data-chat]').forEach(function (sc) { sc.setAttribute('data-live-keep', '1'); });
        }
        // discussion d'une fiche : même principe, la boîte (brouillon, pièces choisies) reste en place
        var oldFil = cur.querySelector('[data-fil]'), newFil = fresh.querySelector('[data-fil]');
        if (oldFil && newFil && oldFil.dataset.fil === newFil.dataset.fil) newFil.replaceWith(oldFil);
        cur.replaceWith(fresh);
        openCollapses.forEach(function (id) { var el = document.getElementById(id); if (el) el.classList.add('show'); });
        runScripts(fresh);
        if (oldChat && newChat && window.ymChatPull) window.ymChatPull();
        activeTabs.forEach(function (id) { var el = document.getElementById(id); if (el && window.bootstrap) try { bootstrap.Tab.getOrCreateInstance(el).show(); } catch (e) {} });
        window.scrollTo(0, y);
        dirty = false; hidePill(); lastRefresh = Date.now();
        if (window.ymInitForms) window.ymInitForms(fresh);
        document.dispatchEvent(new CustomEvent('ym:refreshed'));
      })
      .catch(function () { location.reload(); })
      .finally(function () { inflight = false; if (again) { again = false; refresh(false); } });
  }
  window.ymLiveRefresh = refresh;

  var timer = null;
  function schedule() { clearTimeout(timer); timer = setTimeout(function () { refresh(false); }, 350); }

  var es = null, lastEvent = 0;
  function connect() {
    es = new EventSource('/api/live');
    es.onmessage = function (msg) {
      var ev; try { ev = JSON.parse(msg.data); } catch (e) { return; }
      lastEvent = Date.now();
      if (ev.t === 'notif') { if (window.pollNotifications) window.pollNotifications(); return; }
      if (ev.t === 'fil') { if (ev.by !== me) document.dispatchEvent(new CustomEvent('ym:fil', { detail: ev })); return; }
      if (ev.t === 'chat') { if (dossierId && ev.d === dossierId && ev.by !== me && window.ymChatPull) window.ymChatPull(); return; }
      if (ev.by === me) return;
      if (relevant(ev)) schedule();
    };
  }
  connect();

  // Retour sur l'application (téléphone en veille, onglet caché) : on rattrape ce qui a pu être manqué
  var hiddenAt = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > 20000) {
      if (window.pollNotifications) window.pollNotifications();
      if (es && es.readyState === 2) connect();
      refresh(false);
    }
  });
})();
