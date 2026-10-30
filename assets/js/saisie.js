/* YM-TRANSIT · saisie sur toute la plateforme
   1. Le texte tapé passe en MAJUSCULES (sauf e-mails, mots de passe, adresses web, recherche et discussions).
   2. Les montants s'affichent par groupes de trois chiffres pendant la saisie (1 250 000) ;
      le formulaire envoie toujours le nombre sans espaces. */
(function () {
  /* ---------- 1. Majuscules ---------- */
  var SKIP_NAME = /mail|password|pwd|url|lien|site_web|website|login|username|token|search|^q$/i;
  var NO_CAPS_ZONE = '[data-no-caps], .dchat, .dchat-compose, .fil, [data-fil]';
  function capsTarget(el) {
    if (!el || el.readOnly || el.disabled) return false;
    if (el.closest(NO_CAPS_ZONE)) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    var t = (el.getAttribute('type') || 'text').toLowerCase();
    if (t !== 'text') return false;
    if (isMoney(el)) return false;
    if (el.autocomplete === 'username' || el.autocomplete === 'email') return false;
    return !(SKIP_NAME.test(el.name || '') || SKIP_NAME.test(el.id || ''));
  }
  function upper(el) {
    var v = el.value, u = v.toLocaleUpperCase('fr-FR');
    if (v === u) return;
    var s = el.selectionStart, e = el.selectionEnd;
    el.value = u;
    try { el.setSelectionRange(s, e); } catch (x) { /* champ sans sélection */ }
  }
  document.addEventListener('input', function (ev) { if (capsTarget(ev.target)) upper(ev.target); }, true);
  // Valeurs collées ou remplies automatiquement : on corrige aussi à l'envoi
  document.addEventListener('submit', function (ev) {
    var f = ev.target; if (!f || !f.querySelectorAll) return;
    f.querySelectorAll('input, textarea').forEach(function (el) { if (capsTarget(el)) upper(el); });
  }, true);

  /* ---------- 2. Montants par groupes de trois chiffres ---------- */
  var MONEY_NAME = /montant|valeur|droits|prix|total|frais|liquidation|salaire|prime|avance|honoraire|solde|amount|budget|plafond|jusqua|cout|depense|^reel$|_ht$|_ttc$/i;
  var NOT_MONEY = /quantit|annee|enfant|jours|conges|taux|pourcent|numero|code|_id$/i;
  function isMoney(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    if (el.dataset.noMoney !== undefined) return false;
    if (el.dataset.money !== undefined || el.dataset.moneyOn) return true;
    var t = (el.getAttribute('type') || 'text').toLowerCase();
    if (t !== 'number' && t !== 'text') return false;
    if (el.hasAttribute('data-amt')) return true;
    var n = el.name || '';
    return MONEY_NAME.test(n) && !NOT_MONEY.test(n) && (t === 'number' || el.inputMode === 'decimal' || el.inputMode === 'numeric');
  }
  var raw = function (v) { return String(v == null ? '' : v).replace(/[\s  ]/g, '').replace(',', '.'); };
  function fmt(v) {
    var s = String(v == null ? '' : v).replace(/[\s  ]/g, '');
    if (!s) return '';
    var neg = s[0] === '-' ? '-' : '';
    if (neg) s = s.slice(1);
    var m = s.match(/^(\d*)([.,]\d*)?$/);
    if (!m) return neg + s;
    return neg + m[1].replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (m[2] || '');
  }
  var proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  var done = new WeakSet(); // une ligne clonée garde l'attribut mais pas le comportement : on le repose
  function moneyify(el) {
    if (done.has(el)) return;
    done.add(el);
    el.dataset.moneyOn = '1';
    var cur = proto.get.call(el);
    el.setAttribute('type', 'text');
    el.setAttribute('inputmode', 'decimal');
    el.setAttribute('autocomplete', 'off');
    el.classList.add('money-in');
    // Les scripts lisent le nombre sans espaces ; l'écran montre 1 250 000
    Object.defineProperty(el, 'value', {
      configurable: true,
      get: function () { return raw(proto.get.call(this)); },
      set: function (v) { proto.set.call(this, fmt(v)); },
    });
    proto.set.call(el, fmt(cur));
  }
  function scan(root) {
    (root || document).querySelectorAll('input').forEach(function (el) { if (isMoney(el)) moneyify(el); });
  }
  document.addEventListener('input', function (ev) {
    var el = ev.target;
    if (!el || el.tagName !== 'INPUT') return;
    if (isMoney(el)) moneyify(el);
    if (!done.has(el)) return;
    var shown = proto.get.call(el), pos = el.selectionStart || 0;
    var digitsBefore = shown.slice(0, pos).replace(/[^\d.,-]/g, '').length;
    var next = fmt(shown.replace(/[^\d.,-]/g, ''));
    if (next === shown) return;
    proto.set.call(el, next);
    var i = 0, seen = 0;
    while (i < next.length && seen < digitsBefore) { if (/[\d.,-]/.test(next[i])) seen++; i++; }
    try { el.setSelectionRange(i, i); } catch (x) { /* rien */ }
  }, true);
  // Envoi d'un formulaire (classique ou FormData) : nombres sans espaces
  document.addEventListener('formdata', function (ev) {
    var names = {};
    ev.target.querySelectorAll('input[data-money-on]').forEach(function (el) { if (el.name) names[el.name] = 1; });
    Object.keys(names).forEach(function (n) {
      var vals = ev.formData.getAll(n);
      ev.formData.delete(n);
      vals.forEach(function (v) { ev.formData.append(n, typeof v === 'string' ? raw(v) : v); });
    });
  });
  // Lignes ajoutées après coup (bons, factures) et mises à jour en direct
  new MutationObserver(function (list) {
    list.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1) scan(n.tagName === 'INPUT' ? n.parentNode : n); }); });
  }).observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { scan(); }); else scan();
  window.ymMoney = { fmt: fmt, raw: raw, scan: scan };
})();
