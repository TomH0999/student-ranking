# Classement BUT1 Informatique

Classement **en temps réel** des étudiants du BUT1 Informatique (IUT de Montpellier-Sète), à partir
des notes saisies dans le [gestionnaire de scolarité](https://github.com/TomH0999/gestionnaire_de_notes).

- un classement par **matière** (12 ressources + 6 SAÉ), par **UE** (6) et sur la **moyenne générale** ;
- les moyennes sont recalculées avec **exactement** les formules et coefficients de l'application ;
- chaque classement recense tous les inscrits qui ont la moyenne concernée, et se met à jour tout
  seul dès qu'une note change ;
- un **profil** facultatif (prénom et nom ou pseudo, classe, groupe TD, provenance, parcours visé,
  n° étudiant, détail des notes) dont chacun choisit ce qui est affiché ;
- des **filtres** par classe, groupe TD, provenance et parcours visé ;
- le gestionnaire de scolarité n'est **pas modifié** : le classement lit le même projet Supabase.

Site : <https://tomh0999.github.io/student-ranking/>

---

## Installation et mise en place

À faire **une seule fois**, par la personne qui gère le projet Supabase du gestionnaire de scolarité.
Prérequis : le gestionnaire est déjà configuré avec Supabase (table `items` créée).

### 1. Installer le classement dans Supabase (≈ 1 min)

1. Tableau de bord Supabase → **SQL Editor** → **New query**.
2. Copiez **tout** le fichier [`supabase/ranking.sql`](supabase/ranking.sql) (bouton **Copy raw file**),
   collez-le, cliquez sur **Run**. Résultat attendu : `Success. No rows returned`.

Le script est rejouable sans risque. Il ne modifie ni la table `items`, ni ses données, ni ses règles
de sécurité. Pour tout retirer : [`supabase/uninstall.sql`](supabase/uninstall.sql).

### 2. Ouvrir les inscriptions aux étudiants (≈ 1 min)

Chaque étudiant a besoin de son propre compte sur le projet Supabase.

1. **Authentication → Sign In / Providers** → activez **Allow new users to sign up**.
2. **Authentication → URL Configuration → Site URL** : l'adresse du gestionnaire de scolarité
   (`https://tomh0999.github.io/gestionnaire_de_notes/`), pour le lien de confirmation par e-mail.

### 3. Brancher le site (≈ 1 min)

[`config.js`](config.js) doit contenir les **mêmes** valeurs que le `config.js` du gestionnaire :

```js
window.RANKING_CONFIG = {
    supabaseUrl: "https://xxxxxxxx.supabase.co",
    supabaseKey: "sb_publishable_...",
    appUrl: "https://tomh0999.github.io/gestionnaire_de_notes/"
};
```

Il est déjà rempli pour le projet de ce dépôt. Seule la clé **publique** va ici, jamais la clé
`secret` ni `service_role`.

### 4. Publier (≈ 1 min)

Sur GitHub : **Settings → Pages → Build and deployment** → *Source* : **Deploy from a branch** →
branche **main**, dossier **/ (root)** → **Save**. Le site est en ligne une minute plus tard.

### Vérifier

Ouvrez le site, connectez-vous, rejoignez le classement : la pastille **En direct** est verte.
Ajoutez une note dans le gestionnaire : le classement bouge en une à deux secondes.

---

## Utilisation

### Rejoindre le classement

1. Dans le **gestionnaire de scolarité** : *Réglages → Compte et synchronisation* → créez votre compte
   (ou connectez-vous) et saisissez vos notes. La pastille doit indiquer **Synchronisé**.
2. Ouvrez le **classement** : <https://tomh0999.github.io/student-ranking/>. Si le gestionnaire est
   déjà connecté dans ce navigateur, vous l'êtes aussi ; sinon, entrez le même e-mail et mot de passe.
3. Choisissez un **pseudo** (ou laissez vide pour apparaître sous un nom anonyme du type
   « Étudiant 4F2A ») → **Rejoindre le classement**.

Pour l'installer comme une application : *Partager → Sur l'écran d'accueil* (iPhone, Safari) ou
*Installer l'application* (Chrome, Edge).

### Lire le classement

| Élément | Rôle |
|---|---|
| **Générale / UE / Matières** | Choix du classement ; pour les UE et les matières, une pastille par code (en pointillés : personne n'a encore cette moyenne) |
| **Ma place** | Votre rang sur le nombre de classés, votre moyenne, la moyenne des classés, l'écart avec le premier |
| **Filtres** | Classe, groupe TD, provenance, parcours visé : le classement et les rangs sont recalculés dans la sélection. Un filtre n'apparaît que si quelqu'un a renseigné l'information |
| **Liste** | Tous les inscrits ayant cette moyenne, du premier au dernier ; votre ligne est surlignée ; un liseré vert signale une moyenne qui vient de changer. Un clic sur une ligne ouvre la **fiche** de l'étudiant : profil affiché, moyennes et rangs, détail des notes s'il le partage |
| **Mes classements** | Vos rangs dans toutes les catégories où vous avez une moyenne ; un clic ouvre le classement correspondant |
| **En direct** (en haut) | Verte : mise à jour instantanée. « Hors direct » : rechargement automatique toutes les 30 secondes |

À savoir :

- vous n'apparaissez dans un classement que si vous avez **au moins une note** dans la matière (ou
  dans une matière de l'UE) ;
- deux moyennes identiques à l'affichage (2 décimales) sont **ex æquo** : rangs 1, 2, 2, 4 ;
- rien ne se saisit ici : pour changer une moyenne, modifiez vos notes dans le gestionnaire.

### Mon profil

En bas de page. Tout est facultatif et modifiable à tout moment.

| Rubrique | Contenu |
|---|---|
| **Identité** | Pseudo, prénom, nom, et le nom affiché dans le classement : pseudo **ou** prénom et nom |
| **Scolarité** | Classe, groupe TD (les valeurs déjà saisies par d'autres sont proposées), provenance (bac général, STI2D, autre), parcours visé en 2e année (RACDV, DACS, AGED, IAMSI, indécis, autre), n° étudiant |
| **Ce que les autres voient** | Une case par information. Par défaut : classe, groupe, provenance et parcours affichés ; n° étudiant et détail des notes masqués |

- Une information masquée n'est pas transmise aux autres et ne sert pas aux filtres.
- **Le détail de mes notes** : si vous cochez cette case, les autres inscrits voient chacune de vos
  évaluations (nom, note, barème, coefficient) dans votre fiche. Sinon, ils ne voient que vos moyennes.
- Votre fiche (clic sur votre ligne) montre ce que les autres voient de vous.

Au même endroit : **quitter le classement** (vos moyennes et votre profil disparaissent pour les
autres, vos notes ne sont pas touchées) et **se déconnecter** (déconnecte aussi le gestionnaire sur
cet appareil, les deux sites partageant la même session).

---

## Confidentialité

- Seules les **moyennes** des étudiants qui ont rejoint le classement sont partagées, et uniquement
  avec les autres inscrits. Sans inscription, on ne voit rien et on n'apparaît nulle part.
- Les informations de profil ne sont partagées que si leur propriétaire les affiche.
- Les notes détaillées ne quittent la base que pour les étudiants qui ont choisi de les partager.
  L'adresse e-mail et l'identifiant du compte ne la quittent jamais.
- Les notes sont déclaratives : chacun saisit les siennes, le classement ne vérifie rien.

## Mettre à jour une installation existante

Dans cet ordre, pour que rien ne soit interrompu :

1. **Supabase d'abord** : réexécutez [`supabase/ranking.sql`](supabase/ranking.sql) dans le SQL Editor.
   Le script ajoute ce qui manque sans toucher aux inscrits ni aux pseudos, et le site de la version
   précédente continue de fonctionner avec la base mise à jour.
2. **Le site ensuite** : publiez la nouvelle version sur la branche `main`.

## Dépannage

| Message | Cause | Que faire |
|---|---|---|
| « Le classement n'est pas encore installé… » | Étape 1 non faite | Exécuter `supabase/ranking.sql` |
| « Le classement installé sur Supabase est plus ancien que ce site… » | Site mis à jour avant la base | Réexécuter `supabase/ranking.sql` |
| « Adresse e-mail ou mot de passe incorrect. » | Compte inexistant ou faute de frappe | Créer le compte dans le gestionnaire |
| « Adresse e-mail non confirmée… » | Lien de confirmation non ouvert | Ouvrir l'e-mail reçu à l'inscription |
| Pastille « Hors direct » en permanence | Realtime indisponible ou projet en pause | Tableau de bord Supabase → *Restore project* ; le classement continue par rechargement |
| Je n'apparais pas | Aucune note synchronisée | Vérifier la pastille « Synchronisé » du gestionnaire |

## Développement

Site statique sans étape de build. Outils de test (Node.js 22+) :

```bash
npm install
```

| Commande | Rôle |
|---|---|
| `npm run serve` | Sert le site sur <http://127.0.0.1:4174/student-ranking/> |
| `npm test` | Logique du classement + SQL sur un vrai Postgres (PGlite), dont la parité au bit près avec le calcul de l'application |
| `npm run test:e2e` | Tests navigateur (Chromium bureau et mobile) avec un faux Supabase |

```
index.html, style.css, config.js    site publié
js/                                 programme (copie de l'application), classement, accès Supabase, interface
supabase/                           ranking.sql (installation), uninstall.sql
tests/reference/                    copies de référence du calcul et du schéma de l'application
```

Si les coefficients ou le programme changent dans l'application, reportez-les dans `js/program.js`
et dans `supabase/ranking.sql` (un test vérifie qu'ils concordent).
