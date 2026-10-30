/* YM-TRANSIT · formulaires à lignes (bons provisoires, bons réels, dépenses internes).
   Écouteurs délégués : fonctionnent aussi après une mise à jour en direct de la page. */
(function () {
  var num = function (v) { var n = parseFloat(String(v || '').replace(/\s/g, '').replace(',', '.')); return isNaN(n) ? 0 : n; };
  var fmt = function (n) { return Math.round(n).toLocaleString('fr-FR'); };
  var signed = function (n) { return n === 0 ? '0' : (n > 0 ? '+' : '−') + fmt(Math.abs(n)); };

  /* Bon provisoire / dépense interne : lignes libres + total */
  function calcLines(form) {
    var total = 0;
    form.querySelectorAll('[data-line]').forEach(function (tr) { total += num(tr.querySelector('[data-amt]').value); });
    var t = form.querySelector('[data-total]'); if (t) t.textContent = fmt(total);
    var ti = form.querySelector('[data-total-input]'); if (ti) ti.value = total;
    var rows = form.querySelectorAll('[data-line]');
    rows.forEach(function (tr) { var b = tr.querySelector('[data-del]'); if (b) b.disabled = rows.length <= 1; });
    return total;
  }

  /* Bon réel : écart par ligne et total */
  function calcReel(form) {
    var prov = num(form.getAttribute('data-prov')), total = 0;
    form.querySelectorAll('[data-prov-line]').forEach(function (tr) {
      var r = num(tr.querySelector('[data-amt]').value), e = num(tr.getAttribute('data-prevu')) - r;
      total += r;
      var c = tr.querySelector('[data-ecart]'); c.textContent = signed(e); c.className = 'text-end ' + (e > 0 ? 'text-success' : e < 0 ? 'text-danger' : 'text-muted');
    });
    form.querySelectorAll('[data-new-line]').forEach(function (tr) { total += num(tr.querySelector('[data-amt]').value); });
    var e = prov - total;
    form.querySelector('[data-total]').textContent = fmt(total);
    var et = form.querySelector('[data-ecart-total]'); et.textContent = signed(e); et.className = 'text-end ' + (e > 0 ? 'text-success' : e < 0 ? 'text-danger' : '');
    var msg = form.querySelector('[data-ecart-msg]');
    if (msg) msg.innerHTML = e > 0 ? '<span class="text-success"><i class="bi bi-arrow-down-left-circle me-1"></i>' + fmt(e) + ' F à rendre à la caisse</span>'
      : e < 0 ? '<span class="text-danger"><i class="bi bi-arrow-up-right-circle me-1"></i>' + fmt(-e) + ' F de complément à demander à la caisse</span>'
      : '<span class="text-muted">Aucun écart avec le bon provisoire</span>';
  }

  window.ymInitForms = function (root) {
    (root || document).querySelectorAll('[data-lines-form]').forEach(calcLines);
    (root || document).querySelectorAll('[data-reel-form]').forEach(calcReel);
  };

  document.addEventListener('input', function (e) {
    var f = e.target.closest('[data-lines-form]'); if (f) calcLines(f);
    var r = e.target.closest('[data-reel-form]'); if (r) calcReel(r);
  });

  document.addEventListener('click', function (e) {
    var add = e.target.closest('[data-lines-form] [data-add]');
    if (add) {
      var form = add.closest('[data-lines-form]'), tbody = form.querySelector('tbody'), first = tbody.querySelector('[data-line]');
      var tr = first.cloneNode(true);
      tr.querySelectorAll('input').forEach(function (i) { i.value = ''; });
      tbody.appendChild(tr); tr.querySelector('[data-des]').focus(); calcLines(form); return;
    }
    var del = e.target.closest('[data-lines-form] [data-del]');
    if (del) { var f = del.closest('[data-lines-form]'); if (f.querySelectorAll('[data-line]').length > 1) del.closest('[data-line]').remove(); calcLines(f); return; }

    var addNew = e.target.closest('[data-reel-form] [data-add-new]');
    if (addNew) {
      var rf = addNew.closest('[data-reel-form]');
      var row = document.createElement('tr'), k = (rf._k = (rf._k || 0) + 1);
      row.setAttribute('data-new-line', '');
      row.className = 'cmp-new';
      row.innerHTML = '<td><div class="reel-des"><input name="new_designation" class="form-control form-control-sm" placeholder="Dépense imprévue" required><input type="hidden" name="new_key" value="' + k + '"><label class="reel-recu" title="Joindre le reçu de cette dépense"><input type="file" name="recu_n_' + k + '" accept=".pdf,image/*" multiple capture="environment" hidden data-recu><i class="bi bi-paperclip"></i><span data-recu-label>Reçu</span></label></div></td>' +
        '<td class="text-end text-muted">—</td>' +
        '<td><input type="number" min="0" step="any" name="new_montant" class="form-control form-control-sm text-end" required data-amt></td>' +
        '<td class="text-end text-danger small">imprévu</td>' +
        '<td><button type="button" class="btn btn-sm btn-link text-danger p-0" data-del-new aria-label="Supprimer"><i class="bi bi-trash"></i></button></td>';
      rf.querySelector('[data-new-lines]').appendChild(row); row.querySelector('input').focus(); calcReel(rf); return;
    }
    var delNew = e.target.closest('[data-reel-form] [data-del-new]');
    if (delNew) { var rf2 = delNew.closest('[data-reel-form]'); delNew.closest('[data-new-line]').remove(); calcReel(rf2); }
  });

  // Bon réel : reçu joint sur chaque ligne, au moins un reçu en tout
  document.addEventListener('change', function (e) {
    var inp = e.target.closest('[data-recu]'); if (!inp) return;
    var lab = inp.closest('.reel-recu'), n = inp.files.length;
    lab.classList.toggle('has', n > 0);
    lab.querySelector('i').className = n ? 'bi bi-check2-circle' : 'bi bi-paperclip';
    lab.querySelector('[data-recu-label]').textContent = n === 0 ? 'Reçu' : n === 1 ? (inp.files[0].name.length > 12 ? inp.files[0].name.slice(0, 10) + '…' : inp.files[0].name) : n + ' fichiers';
    lab.title = n ? Array.prototype.map.call(inp.files, function (f) { return f.name; }).join(', ') : 'Joindre le reçu de cette dépense';
  });
  document.addEventListener('submit', function (e) {
    var rf = e.target.closest('[data-reel-form]'); if (!rf) return;
    var any = Array.prototype.some.call(rf.querySelectorAll('[data-recu], [data-recu-any]'), function (i) { return i.files && i.files.length; });
    if (!any) { e.preventDefault(); e.stopImmediatePropagation(); if (window.showToast) showToast('Reçu manquant', 'Joignez au moins un reçu (photo ou PDF) pour justifier la dépense.', null, 'err'); else alert('Joignez au moins un reçu.'); }
  }, true);

  document.addEventListener('submit', function (e) {
    var f = e.target.closest('[data-lines-form]');
    if (!f) return;
    var items = [];
    f.querySelectorAll('[data-line]').forEach(function (tr) {
      var d = tr.querySelector('[data-des]').value.trim(), m = num(tr.querySelector('[data-amt]').value);
      if (d && m > 0) items.push({ designation: d, montant: m });
    });
    if (!items.length) { e.preventDefault(); alert('Ajoutez au moins une ligne avec un montant.'); return; }
    f.querySelector('[data-items-json]').value = JSON.stringify(items);
    calcLines(f);
  }, true);

  if (document.readyState !== 'loading') window.ymInitForms(); else document.addEventListener('DOMContentLoaded', function () { window.ymInitForms(); });
})();
