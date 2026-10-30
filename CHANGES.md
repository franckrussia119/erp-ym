# Services : choisir parmi les employés existants (30 octobre 2026)

- **« Ajouter un employé à ce service »** ouvre la liste de tous les employés actifs (nom, rôle, service actuel) avec une recherche. « Ajouter » range l'employé dans le service (et le retire de l'ancien), « Retirer » l'enlève, « Responsable » le nomme chef du service. Les membres et le responsable actuels apparaissent en tête.
- **Responsable du service** : bouton « Choisir » / « Changer » sur chaque carte, et dans « Modifier » un champ de recherche qui propose tous les employés au lieu d'une longue liste déroulante. Un responsable sans service rejoint celui qu'il dirige ; s'il est déjà dans un autre service, il n'est pas déplacé.
- **Plus de création de compte depuis Services** : les comptes se créent uniquement dans Administration › Utilisateurs. Le super admin y va directement depuis la liste, avec le service déjà choisi.
- **Utilisateurs › « Assigner »** sur chaque rôle ouvre la liste de tous les employés (dossier RH) et de tous les comptes, avec une recherche. Un employé qui a déjà un compte reçoit ce rôle (son compte est réactivé s'il était désactivé). Un employé sans compte reçoit un identifiant et un mot de passe provisoire, et son compte est lié à son dossier RH. « Créer un collaborateur » reste pour une personne qui n'est pas encore dans le personnel. Le super admin ne peut pas changer son propre rôle.
- Le dossier RH de l'employé suit son service (depuis Services comme depuis la fiche utilisateur).

# Interface claire et nette (30 octobre 2026)

- **Bandeaux animés** (tableau de bord, caisse, espace administrateur) : halos verts qui flottent, reflet qui balaie, points qui glissent, pastilles d'icônes en lévitation ; le solde de la caisse et les chiffres du tableau de bord comptent jusqu'à leur valeur. Tout s'arrête si l'appareil demande moins d'animations, et rien ne s'imprime.
- **Ombres douces** : cartes, tuiles, bandeaux, menu et boutons se détachent légèrement du fond gris très clair ; les tuiles cliquables et les boutons se soulèvent au survol. Rien à l'impression.
- **Une seule couleur, le vert** : tous les modules, les étapes du dossier, les tuiles, les services et les graphiques utilisent des nuances de vert. Le rouge reste pour les refus, retards et montants dus ; l'ambre pour ce qui attend. Les services gardent leurs couleurs si elles ont été choisies à la main ; les couleurs d'origine passent au vert au démarrage.
- **Nouveau thème** (`assets/css/clean.css`, chargé après `app.css`) : fond blanc, barre latérale claire, police Instrument Sans, cartes à bordure fine sans ombre, boutons à plat, tableaux et badges pastel. Chaque module garde sa couleur (icônes du menu, boutons, tuiles).
- **Tuiles chiffrées en couleurs pastel** (tableau de bord, factures, caisse, comptes, bons payés) et **bandeaux d'accueil clairs** à la place des bandeaux sombres (tableau de bord, caisse, espace administrateur, discussion du dossier).
- **Tableau des tâches** : en-têtes de colonne pastel ; page de connexion aux couleurs vertes.
- Arrondis harmonisés (12 px au plus).

# Reçu de caisse et registre des bons payés (28 octobre 2026)

- **Reçu de caisse** : quand la caisse paie un bon, la plateforme lui donne un n° de reçu (RC-2026-0001…) et ouvre le reçu à imprimer en deux exemplaires (bénéficiaire et souche caisse) : montant en chiffres et en lettres, bénéficiaire, motif, bon, dossier, mode de paiement, caissier, cases de signature. Les bons déjà payés ont été numérotés dans l'ordre de paiement.
- **N° du reçu papier signé** : la caisse le saisit au moment de payer, ou plus tard sur le reçu ou dans le registre ; elle peut joindre la photo du reçu signé. Seule la caisse le saisit.
- **Menu « Bons payés »** (caisse, direction, comptabilité, audit) : les bons payés du jour (ou d'une période), classés par façon d'émettre le bon (bons de dossier, débours, bons supplémentaires, dépenses internes par catégorie), avec leur reçu, le n° papier, le montant justifié et les totaux. Filtre « reçu signé à saisir », recherche, impression et export Excel. Le menu affiche à la caisse le nombre de reçus signés à saisir sur 30 jours.

# Dossiers, caisse, visas, demandes et facturation (27 octobre 2026, 2e lot)

- **Rejet par le secrétariat** : à l'étape « Créé », le secrétariat peut rejeter un dossier avec un motif (ex. « Client pas prêt à valider »). Le dossier reste au secrétariat, signalé « Rejeté » ; le rejet se lève, ou tombe à la transmission au GUCE.
- **N° de dossier à partir du GUCE** : chaque dossier reçoit son numéro (2026-0001, 2026-0002…) quand il est transmis au GUCE. Avant, il n'a pas de numéro et ne compte pas dans les statistiques du mois. Les dossiers déjà passés au GUCE ont été numérotés dans l'ordre de création.
- **Compte du représentant** : toutes les opérations de ses dossiers y figurent (bons payés, au montant réel une fois justifiés ; droits avancés par la société ; règlements des factures), avec la liste de ses dossiers. Deux impressions : le relevé, et l'activité (les dossiers).
- **Caisse** : l'entrée ne propose plus le dépôt, le reliquat d'un bon ni le remboursement ; la sortie ne propose plus le représentant, le complément ni le paiement à un employé (les comptes passent par la page Comptes, les reliquats par la file Reliquats). Le compteur des bons apparaît aussi sur le menu Caisse.
- **Deux rejets d'un bon** par les titulaires de visa : « rejet pour modification » (le demandeur corrige le montant et renvoie ; les visas repartent de zéro) et « rejet définitif ». L'audit vise maintenant tous les bons.
- **Bon supplémentaire** : quand la dépense réelle dépasse l'avance, le complément devient un bon supplémentaire qui suit les visas avant d'être payé par la caisse (plus de paiement direct du complément).
- **Dépenses internes** : visées par le DAF puis le PDG, et par l'audit ; le DG est informé à la création et à la validation.
- **Demandes** : congé = responsable du service puis RH, le DG et le PDG sont prévenus de la décision (acceptée ou refusée, avec le motif). Avance sur salaire et autres demandes = DAF puis PDG, le DG est prévenu.
- **Débours** depuis Dépenses internes : on choisit un dossier ouvert (le plus récent en tête) et on émet un bon qui entre dans les dépenses du dossier.
- **Facturation** : toutes les dépenses justifiées du dossier sont proposées, cochées, dans la facture finale ; la facturation décoche ou corrige. Vue « Par représentant » (ses dossiers, dépenses, facturé, reste) puis accès à la facturation de chaque dossier. Le PDF de facture porte le n° de facture et le n° de dossier.
- **Plus de « logistique »** nulle part : la société s'appelle YM-TRANSIT (aussi dans les données existantes) et le service Achats a le code ACHATS.

# Ressources humaines et paie (octobre 2026)

- **Menu Ressources humaines** (RH, DAF, direction) : tableau de bord (effectif par service, absents de la
  semaine, contrats qui finissent, coût de la dernière paie) et **dossier de chaque employé** : identité,
  poste, service, contrat, salaire et primes fixes, banque, n° CNPS et NIU, pièces (contrat, CNI, diplômes…),
  notes RH. Un dossier a été créé automatiquement pour chaque compte existant.
- **Compte de connexion depuis le dossier** (mot de passe provisoire à changer) ; un départ désactive le compte.
- **Congés payés** : 1,5 jour par mois de service, moins les congés annuels approuvés dans Demandes.
- **Paie mensuelle Cameroun** : la RH prépare la paie (un bulletin par employé), saisit primes du mois,
  absences et avances ; le DAF, le DG ou le PDG la valide. Calcul : CNPS (pension, allocations familiales,
  accidents du travail), IRPP et CAC, CFC, FNE, RAV, TDL. **Tous les taux se règlent dans RH › Barème de
  paie** : à faire vérifier par le comptable avant la première paie.
- À la validation, **l'écriture de paie** est passée au journal PAI (661, 664, 6412 / 431, 4472, 421, 422) et
  chaque employé reçoit son bulletin. Au paiement : écriture 422 / banque ou caisse (et sortie de caisse
  « Paie du personnel » si payé en espèces).
- **Bulletin de paie** imprimable ou en PDF ; **Mes bulletins** pour chaque employé ; exports Excel du livre
  de paie et de l'ordre de virement.
- Le **résultat par service** compte maintenant les salaires (coût total, charges patronales comprises).
- Lien « Transport (camions) » vers https://accounting.ym-transit.com par défaut.

# Lien vers la plateforme transport (octobre 2026)

- Le transport par camions reste sur sa propre plateforme. Un lien « Transport (camions) » apparaît dans le menu,
  section « Autres plateformes », et l'ouvre dans un nouvel onglet.
- L'adresse se règle dans Administration › Plateformes externes (PDG, DG, super admin), sans redéploiement.
  D'autres plateformes peuvent y être ajoutées. Avant tout réglage, la variable TRANSPORT_URL est utilisée.

# Discussion sur les demandes, les bons et les clients (octobre 2026)

- Chaque demande, chaque bon et chaque fiche client a maintenant sa **discussion**, comme celle des dossiers :
  messages, photos, vidéos et documents (10 fichiers, 64 Mo chacun), mentions avec @ (la personne citée est
  prévenue), suppression de ses propres messages pour tout le monde. Mise à jour en direct.
- Les personnes liées à la fiche (demandeur, validateurs, auteur du bon) et celles qui ont déjà écrit sont
  prévenues de chaque nouveau message. La discussion d'une demande n'est visible que par les personnes de son
  circuit, la direction et la RH. Les comptes en lecture seule peuvent lire mais pas écrire.

# Demandes et circuit d'approbation (octobre 2026)

- **Menu Demandes** : congé ou absence, achat, réparation ou entretien, autre demande (avance, formation,
  mission…). Pièces jointes possibles. Pour un congé, les jours ouvrés sont comptés automatiquement.
- **Circuit de validation étape par étape** : d'abord le responsable du service du demandeur, puis selon le
  type et le montant (ex. achat : DAF ; à partir de 500 000 F : DG ; à partir de 2 000 000 F : PDG ; congé : RH).
  Chaque validateur est prévenu à son tour, le demandeur à chaque étape. Un refus exige un motif.
- **Onglet « À valider »** avec validation en un clic, compteur dans le menu. La direction et la RH voient
  toutes les demandes et les absents de la semaine.
- Personne ne valide sa propre demande ; sans responsable de service, le DG prend l'étape ; la demande du DG
  va au PDG ; celle du PDG est validée d'office.
- **Administration › Circuits d'approbation** (PDG, DG) : changer les étapes et les tranches de montant.
- Un achat ou une réparation approuvé peut être transformé en dépense interne pré-remplie (bouton
  « Demander l'argent à la caisse »).

# Services et centres de coût (octobre 2026)

- **Services de l'entreprise** (Administration › Services) : Direction générale, Transit & douane, Transport
  routier, Comptabilité & finance, Ressources humaines, Commercial & marketing, Achats & magasin. On peut en
  créer d'autres, changer le nom, la couleur, l'icône, le responsable et les membres.
- **Chaque employé appartient à un service.** Au premier démarrage, chacun est rangé selon son rôle ; les
  anciennes écritures sont rattachées automatiquement. Le service se choisit aussi dans la fiche utilisateur.
- **Chaque mouvement d'argent porte un service** (centre de coût) : bons de débours, dépenses internes,
  mouvements de caisse, factures clients et fournisseurs. Un dossier va à Transit & douane ; une dépense
  interne va au service de son auteur (modifiable dans le formulaire) ; la caisse peut choisir le service
  d'une entrée ou sortie manuelle.
- **Résultat par service** (Pilotage) : facturé, encaissé, dépenses de caisse, factures fournisseurs et
  résultat de chaque service sur une période, avec le détail des principales dépenses.

# Fiche dossier allégée et discussion de groupe (octobre 2026)

- **Fiche dossier plus claire** : en haut, l'en-tête, la prochaine action, les conteneurs et les pièces
  obligatoires. Le reste est rangé derrière des boutons (« Le dossier en détail ») qui ouvrent un panneau à la
  fois : Douane · CAMCIS, Documents, Bons de débours, Importateur, Spécifications, Étapes et tâches,
  Suivi client, Chronologie. Un lien direct (ex. bouton BAE) ouvre la bonne section.
- **Rentabilité et Factures et devis** n'apparaissent qu'à partir de l'étape Facturation.
- **Discussion du dossier** fixée à droite, comme un groupe WhatsApp : messages en direct sans recharger,
  changements d'étape affichés dans le fil, brouillon conservé. Chaque message prévient tous les membres
  du dossier (ceux qui y ont travaillé et les responsables de l'étape en cours), direction comprise.
  Sur téléphone et tablette : bouton rond en bas à droite avec le nombre de messages non lus.
- Correction : la direction (PDG, DG, DGA, DAF, audit) ne pouvait pas écrire dans la discussion.

# Version 4 : circuit complet, caisse et dépenses internes (octobre 2026)

## Ce qui change pour les utilisateurs

1. **Nouveau dossier en 6 étapes** (Client, Expédition, Conteneurs, Pièces, Douane et fisc, Vérifier) avec
   les boutons Suivant et Précédent. Rien n'est enregistré avant la dernière étape.
2. **Conteneurs du BL** : la secrétaire saisit chaque numéro (ou colle une liste), avec le type et le scellé.
   Le numéro est contrôlé (format ISO), et la recherche trouve un dossier par numéro de conteneur.
   La liste reste modifiable sur la fiche du dossier.
3. **Accès au circuit** : toute la ligne d'un dossier est cliquable, et la liste a une vue « Par étape ».
4. **GUCE : le DESC devient le BESC.**
5. **Nouvelle étape 4 « Facture 1 & banque »**, après la validation CAMCIS. Le service facturation émet la
   facture 1 (droits de douane) au client, puis saisit la quittance bancaire, le montant, la date, la banque
   et le scan. La quittance n'est plus demandée à la validation.
6. **Mise à jour en direct** : les pages se mettent à jour seules quand quelqu'un agit ailleurs. Pendant la
   saisie d'un formulaire, un bouton « Actualiser » apparaît au lieu de recharger.
7. **Bon réel** : les lignes du bon provisoire sont verrouillées. Le montant réel se saisit en face de chaque
   ligne, une dépense imprévue s'ajoute en nouvelle ligne, et le bon compare prévu, réel et écart.
8. **La caisse suit chaque bon dès sa création** et les visas en direct, avec une notification à chaque visa.
   Elle paie quand les visas sont complets, ou plus tôt sur ordre du PDG ou du DG (nom enregistré et imprimé).
9. **Module Caisse** (`/caisse`) : solde, entrées (règlement client lié à une facture, approvisionnement,
   reliquat, remboursement), sorties, journal avec solde cumulé, export CSV, clôture du jour avec écart
   signalé au DAF. Bons payés, reliquats et compléments s'y inscrivent seuls.
10. **Dépenses internes** (`/depenses`) : demande d'argent hors dossier, visée par le DAF et le DG, plus le
    PDG à partir de 500 000 F (`INTERNAL_PDG_THRESHOLD`). La caisse paie, le demandeur justifie ensuite.
11. **Nom du dossier = nom du client**, avec le BL et le contenu juste en dessous (ex. SOFOMEUTEX, puis
    « BL 2548956656 · Articles friperie »). La référence est créée seule à partir du client et du BL
    (SOFOMEUTEX-2548956656, ou le sigle entre parenthèses pour un nom long). Le contenu est obligatoire.
12. **Mon espace** (`/mon-espace`) : dossiers à mon étape avec retard, mes tâches, mes demandes, mon mois.

## Corrections du circuit

- **Montants des PDF** (bons et factures) : « 80 /000 F » s'affiche maintenant « 80 000 F ». Un nom de client
  long ne chevauche plus le NIU sur la facture.
- **Les fenêtres (ajouter une prestation, encaisser, modifier un client, tâches…) bloquaient la page** :
  elles s'ouvraient sous leur fond gris. Cause : une règle de mise en page (`isolation` sur la zone principale).
  Corrigé pour toutes les fenêtres de l'application (149 vérifiées sur 8 rôles).
- Le service facturation ne pouvait pas « Marquer facturé » : le rôle manquait.
- Chaque bouton d'étape vérifie l'étape du dossier et le rôle (un double clic ne fait plus sauter d'étape).
- Une facture manuelle ne fait plus passer n'importe quel dossier en clôture.
- La saisie CAMCIS n'efface plus la quittance.
- Le paiement d'une facture d'une deuxième société ne plante plus (« Comptes requis introuvables »).
- Deux factures ou bons créés dans la même seconde ne se bloquent plus (numéro en double).
- Les rappels automatiques gèrent les dépenses internes et les visas « non requis ».
- Une erreur dans une page affiche un message au lieu d'arrêter le serveur.
- Les anciennes notifications ne s'empilent plus à l'écran à chaque page.

## Base de données

Nouvelles tables (Conteneur, CaisseMouvement, CaisseCloture) et colonnes facultatives : mise à jour
automatique au démarrage, sans perte de données.

# Corrections de sécurité et de fiabilité (octobre 2026)

## Ce qui change

1. **`/demo-login` est désactivé.** Il connectait n'importe qui en Super Admin sans mot de passe.
   Il ne fonctionne plus que hors production avec `ENABLE_DEMO_LOGIN=true`.
2. **Les mots de passe ne sont plus réinitialisés au démarrage.** Les comptes initiaux ne sont créés
   que sur une installation neuve (personne ne s'est encore connecté), et doivent changer leur mot
   de passe à la première connexion. `prisma/seed.ts` ne vide plus jamais une base qui contient des utilisateurs.
3. **`prisma-check.js` ne supprime plus jamais la base.** Il ne bascule plus sur une base vide et
   n'utilise plus `--accept-data-loss`. En cas de problème, le démarrage s'arrête avec un message clair.
   `nixpacks.toml` ne lance plus `db push --accept-data-loss` non plus.
4. **Les fichiers de `/uploads` exigent une connexion.** `/api/debug-prisma` est réservé au Super Admin.
   Les cookies et identifiants de session ne sont plus écrits dans les logs. Plus de secret de session codé en dur.
5. **Contrôle des rôles** sur toutes les routes `/facturation` (module facturation) et `/stock` (module stock).
   **Les 5 visas (PDG, DG, DGA, DAF, Audit) sont obligatoires** pour approuver un bon provisoire, quel que
   soit l'approbateur. Un bon déjà approuvé ou rejeté ne peut plus être ré-approuvé. Les signataires reçoivent
   maintenant la notification « Nouveau Bon Provisoir créé » (le rôle « direction » n'existait pas).
6. **La page « Nouvelle facture » (`/facturation/new`) ne plante plus** (ordre des routes corrigé).
7. **`package-lock.json` régénéré** : `npm ci` fonctionne de nouveau.
8. Correction annexe : un utilisateur obligé de changer son mot de passe ne pouvait pas le faire
   (le formulaire était redirigé). C'est corrigé.

## À faire après le déploiement

- Comme l'ancienne version remettait les mots de passe par défaut à chaque démarrage, **tous les comptes
  ont actuellement leur mot de passe par défaut** (`admin123`, `pdg123`...). Changez-les tout de suite,
  ou forcez le changement depuis Admin > Utilisateurs.
- Définissez `SESSION_SECRET` dans Coolify (sinon un secret temporaire est utilisé et les sessions sont perdues à chaque redémarrage).
- Vérifiez que `/app/data` (base) et `/app/uploads` (fichiers) sont sur des volumes persistants.

## Version 3 — circuit douanier, rentabilité et application installable

### Circuit du dossier
- L'étape 3 s'appelle **Validation CAMCIS**. On y saisit le n° de déclaration, la date, les droits liquidés, la quittance et le **circuit** (vert, jaune, rouge).
- Circuit jaune ou rouge : une **visite douanière** est créée (tâche + alerte à l'acconage) et doit être marquée terminée.
- Saisie du **bon à enlever (BAE)** ; le client est prévenu par e-mail quand la marchandise est libérée.
- **Pièces obligatoires** par étape (BL et facture commerciale avant le GUCE, quittance d'assurance avant la validation, déclaration CAMCIS avant le traitement, quittance + BAE (+ visite) avant la facturation). Le dossier ne peut pas avancer s'il en manque.
- **Délais par étape** (24 à 72 h) : badge « Reste X h » / « En retard » sur le dossier, alerte aux responsables et à la direction en cas de retard.
- Historique daté de chaque changement d'étape (`DossierStageLog`).

### Argent
- Carte **Rentabilité** sur chaque dossier : avances, dépenses justifiées, facturé, encaissé, marge (HT), avances non justifiées, dépenses non facturées.
- **Facture en un clic** à partir des bons réels (débours exonérés) + honoraires avec TVA 19,25 %, écriture comptable comprise. Les factures sont désormais liées au dossier (`Document.dossier_id`).
- L'envoi de la facture (étape Facturation) exige une facture liée au dossier.

### Direction et rappels
- Page **Visas en attente** (`/bons/visas`) : un bouton « Viser » par bon, pensé pour le téléphone.
- Rappels automatiques : visas en attente (toutes les 12 h), décaissement en attente, avances non justifiées après 7 jours, dossiers en retard.

### Clients
- **Lien de suivi** privé par dossier (`/suivi/<code>`), sans montants, à envoyer par WhatsApp ou e-mail.
- E-mails automatiques aux étapes clés si `SMTP_HOST` est configuré et que le client a un e-mail.

### Pilotage
- Page **Pilotage & rentabilité** (`/rapports`) : temps moyen par étape, dossiers en retard, avances non justifiées, dépenses non facturées, rentabilité par dossier, activité par client et par port, dépenses par nature.

### Application installable (PWA) et notifications push
- Manifeste, icônes, service worker, page hors ligne : l'ERP s'installe sur Android, iPhone (via « Sur l'écran d'accueil ») et ordinateur.
- **Notifications push** : chaque employé est prévenu sur son téléphone dès qu'un dossier arrive à son niveau, qu'un visa l'attend ou qu'un retard est détecté, même application fermée. Activation depuis la cloche ou le menu utilisateur.
- Nécessite HTTPS (fourni par Coolify). Voir les nouvelles variables dans `.env.example`.

### Caisse regroupée
- En tête : le solde de la caisse en grand, les entrées et sorties du jour, la dernière clôture, et trois boutons (Entrée, Sortie, Clôturer).
- « À traiter » : quatre boutons (À payer, Régularisations, En cours de visa, Factures à encaisser) avec leur nombre ; un seul panneau ouvert à la fois. « Encaisser » sur une facture pré-remplit l'entrée (catégorie, facture, montant restant).
- Clôture dans une fenêtre : solde attendu, argent compté, écart calculé pendant la saisie.
- Journal regroupé par jour avec les totaux du jour ; seuls les mouvements du jour sont dépliés, 8 lignes puis « Voir les autres ». Filtres repliés derrière un bouton, export Excel inchangé.

### Reçus sur chaque ligne du bon réel
- Un bouton « Reçu » à côté de chaque ligne (prévue ou imprévue) : photo (l'appareil photo s'ouvre sur téléphone) ou PDF, plusieurs fichiers possibles. Le bouton passe au vert avec le nom du fichier.
- Au moins un reçu est obligatoire (contrôlé dans le navigateur et sur le serveur) ; « Autres reçus » reste disponible pour les pièces générales.
- Sur le bon, chaque ligne affiche son reçu (« Voir ») ou « Sans reçu » pour que la caisse le voie d'un coup d'œil.
- Corrigé : les reçus d'un bon de dossier ne s'ouvraient pas depuis la page du bon (ils étaient cherchés dans le mauvais dossier).
- Sur téléphone, le bon réel s'affiche ligne par ligne, sans défilement horizontal.

### Tout employé peut demander un bon dans un dossier
- Bouton vert « Demander un bon » en haut de chaque dossier, et formulaire dans « Bons de débours ». Ouvert à tous les comptes (sauf lecture seule), à toutes les étapes jusqu'à la facturation ; refusé une fois le dossier clôturé ou archivé.
- Le bon suit le circuit habituel (visas, ordre, paiement par la caisse). Le dossier ne change pas d'étape ; seul le premier bon en « En traitement » le fait passer à « Bon provisoire », comme avant.
- Le demandeur justifie ensuite sa dépense (bon réel avec reçus) depuis le bon, Mon espace ou la notification : une seule page pour les bons de dossier et les dépenses internes. Les dépenses hors dossier restent dans « Dépenses internes ».

### Discussion du dossier façon WhatsApp
- **Mentions** : taper « @ » ouvre la liste des membres ; la personne mentionnée reçoit « 🔔 X vous a mentionné » et voit son nom surligné.
- **Photos, vidéos, audio et documents** (10 fichiers, 64 Mo chacun) : aperçu avant envoi, barre de progression, photos en grille et en plein écran, vidéos lues dans le fil. Coller une capture d'écran l'ajoute aussi.
- **Répondre** à un message (citation cliquable), **copier**, **supprimer pour tous** (son propre message ; le super admin peut tout supprimer). Le texte reste en base pour l'historique, mais n'est plus visible et ses pièces ne s'ouvrent plus.
- **Accusés de lecture** : ✓ envoyé, ✓✓ lu par quelqu'un, ✓✓ bleues lu par tout le groupe ; « Vu par… » liste qui a lu et à quelle heure, et qui n'a pas encore lu.
- Menu d'un message : flèche au survol sur ordinateur, appui long sur téléphone.
- Grand écran : la discussion reste fixée sous la barre du haut, même en bas de page.
- Base : nouvelle table ChatSeen et colonnes facultatives sur DossierComment, ajoutées au démarrage sans perte de données.

## Socle, étape 1 : PostgreSQL et sauvegardes
- **La base passe de SQLite à PostgreSQL.** Au premier démarrage, `prisma-check.js` recopie automatiquement `/app/data/prod.db` si PostgreSQL est vide (une seule transaction, nombres de lignes vérifiés table par table, fichier SQLite jamais modifié). Copie manuelle possible : `node prisma/import-sqlite.js <prod.db>`. Guide pas à pas : `plan/deploiement-postgresql.md`.
- Démarrage refusé avec un message clair si `DATABASE_URL` pointe encore vers un fichier SQLite ; nouvel essai pendant une minute si PostgreSQL n'est pas encore prêt.
- La recherche globale ignore maintenant les majuscules et minuscules (comme avant sous SQLite).
- **Sauvegarde automatique quotidienne** (toutes les tables, `.json.gz`, 14 gardées) dans `/app/data/backups`, avec la page *Administration > Sauvegardes* (état, téléchargement, sauvegarde immédiate) et `node prisma/restore-backup.js` pour restaurer dans une base vide.
- Les clés des notifications push restent dans `/app/data` : les téléphones déjà abonnés continuent de recevoir les notifications.
- `docker-compose.dev.yml` fournit un PostgreSQL local.
- Corrigé : la page « Nouvelle tâche » plantait (variable inexistante dans la vue).

## Nouveau mot de passe après chaque mise à jour

- À chaque nouvelle version déployée, tous les comptes actifs doivent choisir un nouveau mot de passe à leur prochaine connexion : ils se connectent avec l'ancien, puis l'écran Mon profil leur demande d'en choisir un autre avant d'accéder aux modules.
- La version est détectée automatiquement (empreinte du serveur compilé) ; `APP_VERSION` peut la fixer, `PASSWORD_RENEW_ON_UPDATE=false` coupe le renouvellement.
- Le nouveau mot de passe doit être différent de l'actuel.
- Correction : les messages d'erreur de la page Mon profil (mot de passe incorrect, confirmation différente…) ne s'affichaient pas.

## Correction : le serveur redémarrait en boucle au premier démarrage sur PostgreSQL

- La reprise automatique de prod.db s'arrêtait sur « Cycle de clés étrangères : User → Departement → User » (un employé appartient à un service, un service a un responsable). Le démarrage était interrompu, PostgreSQL restait vide, et le conteneur recommençait.
- La reprise et la restauration d'une sauvegarde copient maintenant ces liens en deux temps (la clé du service de chaque utilisateur est remplie à la fin). Testé sur quatre anciennes bases (jusqu'à 5 891 lignes) et sur la restauration d'une sauvegarde complète : données identiques.
- package.json indique Node 22.13 ou plus (nécessaire pour lire l'ancienne base SQLite).

## Pièces obligatoires bien visibles, BAE facultatif

- Quand il manque une pièce obligatoire, un bandeau orange apparaît en haut de « Prochaine action » avec la liste des pièces manquantes, et l'encadré « Pièces obligatoires » passe en orange avec un compteur rouge (les pièces manquantes en premier). Vert quand tout est fourni, gris quand rien n'est exigé.
- Le bon à enlever (BAE) n'est plus obligatoire : un dossier dont tous les bons sont justifiés passe en facturation sans lui. Il peut toujours être saisi plus tard. Un bouton « Passer en facturation » débloque les dossiers qui n'attendaient plus que le BAE.
- La frise des étapes tient sur une seule ligne (l'étape « Archivé » passait à la ligne).

## Lot 1 du 26 octobre : saisie en majuscules, montants lisibles, valeur CAF

- Page Stock retirée (menu et page ; les anciens liens renvoient au tableau de bord).
- Nouveau dossier : le RCCM n'apparaît plus dans l'encadré client.
- Tout texte tapé passe en MAJUSCULES sur toute la plateforme (champs et zones de texte), sauf les e-mails, mots de passe, adresses web, la recherche et les discussions.
- Les montants s'affichent par groupes de trois chiffres pendant la saisie (1 250 000) ; le formulaire envoie toujours le nombre sans espaces. Les montants enregistrés dans les journaux sont aussi écrits ainsi.
- Nouveau dossier : la « Valeur CAF (FCFA) » est obligatoire (contrôlée à l'écran et par le serveur).

## Lot 2 du 26 octobre : validation CAMCIS

- N° d'ordre attribué à chaque déclaration validée (AAAA-MM-NNN, la numérotation repart à 001 chaque mois). Les dossiers déjà validés ont été numérotés au démarrage, dans l'ordre de leur validation.
- Nouveau « Registre des validations » (menu Opérations) : dossiers validés regroupés par mois avec leur nombre, filtres (mois, dates, client, circuit, recherche), tri, export Excel.
- N° GN et N° DAU : deux nouveaux champs obligatoires pour valider.
- Articles et codes tarifaires saisis à la validation, avec propositions pendant la frappe (par article ou par code). Chaque code saisi est gardé dans le dictionnaire « Codes tarifaires », consultable par tous, où l'on peut aussi ajouter des codes un par un ou coller une liste.

## Lot 3 du 26 octobre : facture 1

- Un seul formulaire « Facture 1 et paiement des droits » : droits liquidés, frais bancaires, total calculé en direct (droits + frais), banque, paiement par (le client ou la société), mode de paiement (banque ou caisse), n° et pièce de quittance.
- La facture 1 est émise automatiquement à l'enregistrement quand tout est rempli (plus de second bouton « Émettre la facture »). Son montant comprend les frais bancaires. S'il manque une information, rien n'est émis et un message rouge dit ce qui manque.
- Payé par la société en caisse : la sortie de caisse (droits + frais) est enregistrée en même temps.
- « Argent versé par » est remplacé par « Paiement par » (client ou société).
- Nouvelle page Administration › Banques (direction, DAF, comptabilité) : on ajoute, renomme ou retire une banque ; le formulaire propose la liste au lieu d'un texte libre. Les banques déjà saisies sur des dossiers et les principales banques du pays sont ajoutées au premier démarrage.

## Lot 4 du 26 octobre : bons provisoires

- Choix obligatoire « Urgent / Non urgent » à l'émission de tout bon provisoire, bon de dossier comme dépense interne, quel que soit l'émetteur.
- Un bon urgent passe en tête des visas et de la caisse, avec un bandeau rouge « URGENT » ; les notifications commencent par « 🔴 URGENT ». Le badge apparaît aussi sur la page du bon, dans le dossier, dans Dépenses internes et sur le PDF.
- Contenu du bon de dossier : nom de l'émetteur, client, montant, BL, marchandise, puis la référence interne en petit.
- Contenu du bon interne : nom de l'émetteur, raison du bon et détail des lignes.

## Lot 5 du 26 octobre : caisse, reliquats, banques et comptes

- Entrées de caisse : « Reliquat rendu sur un bon (bon justifié) » affiche directement les bons qui attendent leur reliquat ; on en choisit un et Enregistrer le solde (le montant est celui du bon). « Reliquat reçu d'un bon (retour en caisse) » : le porteur rend tout ou partie de l'argent avant de justifier ; tout rendu, le bon est clos ; une partie, elle est déduite à la régularisation. « Autre entrée » reste.
- Panneau « Reliquats » dans À traiter : chaque bon avec le montant à recevoir ou à payer, et un bouton Encaisser ou Payer qui le solde en un clic.
- Sorties : « Complément payé sur un bon » (même liste de bons) et « Paiement à un représentant ou un employé ».
- Banques : le versement à la banque se fait en choisissant la banque dans la liste (obligatoire) ; la liste apparaît aussi pour un approvisionnement, un chèque ou un virement. La banque figure dans le journal et l'export Excel.
- Comptes (menu Caisse & dépenses) : chaque représentant et chaque employé a son compte et son relevé. Un règlement client versé par un représentant est crédité sur son compte ; ce que la caisse lui paie y figure aussi. Pour le personnel : bons payés, reliquats rendus, compléments, paiements, et les bons encore à justifier. Chaque employé voit son propre compte (Mon espace › Mon compte) ; la fiche d'un représentant a un lien « Relevé de compte ». Les mouvements déjà liés à un bon ont été rangés sur le compte de son porteur.
- Correction : le message de confirmation s'affiche de nouveau sur la page d'un bon après une justification ou une demande de dépense.

## Modifications du 27 octobre

- Comptes : boutons « Créditer » et « Débiter » sur le relevé de chaque représentant et de chaque employé (caisse). Un dépôt crédite le compte et entre en caisse ; un paiement débite le compte et sort de la caisse ; la banque est demandée pour un chèque ou un virement. Sens du compte : ce que la caisse donne est un moins, ce que la personne verse, rend ou justifie est un plus (un bon payé puis justifié revient à zéro). Nouvelle catégorie d'entrée « Dépôt sur un compte ».
- Comptes : seule la caisse crédite ou débite directement, et jamais son propre compte. Tout autre utilisateur (et l'agent de caisse sur son propre compte) fait une **demande de dépôt ou de retrait** : rien ne bouge tant qu'un agent de caisse, autre que le demandeur et le titulaire, ne l'a pas confirmée. La caisse retrouve les demandes dans la file « Dépôts & retraits » ; à la confirmation, le mouvement entre ou sort de la caisse et du compte ; un refus (avec motif) ne bouge rien. Le demandeur est notifié et voit l'état de ses demandes sur son relevé.
- Fournisseurs retirés (menu, fournisseurs, bons de commande, factures fournisseurs) ; les anciens liens renvoient au tableau de bord.
- Services : bouton « Ajouter un utilisateur à ce service » ; le compte est rangé dans le service, reçoit un mot de passe provisoire à changer et son dossier RH. Le rôle super administrateur ne peut pas être donné depuis cette page.
- Ressources humaines : onglets communs (Vue d'ensemble, Employés, Paie, Congés, Barème, Services) ; vue d'ensemble avec ce qui attend la RH (paie du mois, dossiers à compléter, congés à valider, fins de contrat) ; liste des employés en tableau avec salaire, état du dossier et filtre « Dossiers à compléter ».
- Interface : tableau de bord de la direction limité aux 6 premiers bons à viser (urgents d'abord) avec lien vers tous ; cartes de bons plus lisibles ; page Factures et devis refaite (indicateurs, barre d'encaissement, état) ; port abrégé dans la liste des dossiers ; cartes chiffrées cliquables corrigées.
