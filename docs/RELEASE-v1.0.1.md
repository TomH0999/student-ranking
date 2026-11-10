Classement en temps réel des étudiants du BUT1 Informatique, calculé à partir des notes du [gestionnaire de scolarité](https://github.com/TomH0999/gestionnaire_de_notes), sans le modifier.

Installation, mise en place et mode d'emploi : [README](https://github.com/TomH0999/student-ranking#readme).

## Spécificités

**Classements**
- 25 classements : moyenne générale, 6 UE, 18 matières (12 ressources et 6 SAÉ).
- Chaque classement recense tous les inscrits qui ont la moyenne concernée.
- Ex æquo sur la moyenne affichée (2 décimales), rangs de type 1, 2, 2, 4.
- « Ma place » : rang, moyenne, moyenne des classés, écart avec le premier.
- « Mes classements » : mes rangs dans toutes les catégories, en un coup d'œil.

**Calcul**
- Mêmes formules, coefficients et ordre de calcul que l'application : les moyennes sont identiques au bit près à celles qu'elle affiche (vérifié sur 40 jeux de notes aléatoires).
- Calcul fait dans la base : les notes détaillées n'en sortent jamais.

**Temps réel**
- Mise à jour en une à deux secondes après l'ajout, la modification ou la suppression d'une note, sans recharger la page.
- Si le direct est coupé : rechargement automatique toutes les 30 secondes, puis rattrapage à la reconnexion.

**Comptes et confidentialité**
- Même compte que le gestionnaire ; session reprise automatiquement quand les deux sites sont ouverts dans le même navigateur.
- Participation volontaire : on rejoint le classement en un clic, on le quitte quand on veut.
- Pseudo libre, ou nom anonyme automatique (« Étudiant 4F2A »). Jamais d'e-mail ni d'identifiant de compte.
- Seuls les inscrits voient le classement ; aucun accès sans connexion.

**Technique**
- Site statique (GitHub Pages), installable sur l'écran d'accueil, bureau et mobile, sans dépendance externe ni CDN.
- Un seul script SQL à exécuter dans Supabase (`supabase/ranking.sql`), rejouable, avec script de désinstallation. La table et les règles de sécurité de l'application ne sont pas modifiées.
- Une panne du classement ne peut pas empêcher l'enregistrement d'une note dans l'application.

## Corrections depuis la v1.0.0

Trouvées en essayant l'outil sur le vrai projet Supabase :

- **Inscription impossible** : « Rejoindre le classement » était refusé par la base (erreur 403). Corrigé dans le site.
- **Moyennes tronquées à 15 chiffres** : Supabase arrondit les décimaux en sortie par défaut ; les moyennes sont maintenant transmises avec tous leurs chiffres. `supabase/ranking.sql` a changé : **à réexécuter** si la v1.0.0 était installée.

## Vérifié sur le projet Supabase réel

- Connexion, inscription, pseudo, pseudo réservé refusé, accès anonyme refusé.
- Les notes des autres comptes restent illisibles.
- Le signal temps réel s'incrémente à chaque note ajoutée par un inscrit.
- Moyennes par matière, par UE et générale identiques à celles de l'application sur un jeu de notes réel.

## Limites connues

- Programme du semestre 1 uniquement (celui de l'application).
- Les notes sont déclaratives : le classement ne vérifie pas ce que chacun saisit.
- Un étudiant qui n'a pas rejoint le classement n'y figure pas, même s'il utilise le gestionnaire.
- Le direct passe par une connexion WebSocket : il a été vérifié jusqu'au signal en base, pas jusqu'à l'écran d'un navigateur réel.
