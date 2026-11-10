Profil personnalisable et filtres pour le classement du BUT1 Informatique.

Installation, mise à jour et mode d'emploi : [README](https://github.com/TomH0999/student-ranking#readme).

## Nouveautés

**Profil personnalisable** (tout est facultatif)
- Nom affiché au choix : pseudo, ou prénom et nom.
- Classe, groupe TD, provenance (bac général, STI2D, autre), parcours visé en 2e année (RACDV, DACS, AGED, IAMSI, indécis, autre), n° étudiant.
- Une case par information pour choisir ce que les autres voient. Par défaut : classe, groupe, provenance et parcours affichés ; n° étudiant et détail des notes masqués.
- Partage du détail des notes, sur choix de l'étudiant : chaque évaluation avec sa note, son barème et son coefficient.

**Filtres**
- Par classe, groupe TD, provenance et parcours visé, combinables.
- Rangs, « Ma place » et « Mes classements » recalculés dans la sélection.
- Un étudiant qui masque une information n'est pas retrouvable par le filtre correspondant.

**Fiche d'un étudiant**
- Un clic sur une ligne : profil affiché, moyennes et rangs dans chaque catégorie, détail des notes s'il est partagé.
- Votre propre fiche montre ce que les autres voient de vous.

**Confort**
- Une mise à jour en direct ne touche plus au formulaire en cours de saisie, au focus clavier ni à une liste de filtre ouverte.

## Compatibilité

- Rien ne change pour les inscrits actuels tant qu'ils ne complètent pas leur profil : même nom, mêmes moyennes, mêmes rangs.
- `supabase/ranking.sql` est **à réexécuter avant** de publier le site. Il ajoute des colonnes et une fonction sans modifier les données existantes ; le site v1.0.1 continue de fonctionner avec la base mise à jour.

## Limites connues

- Programme du semestre 1 uniquement.
- Les notes et les informations de profil sont déclaratives : rien n'est vérifié.
- Classe et groupe TD sont en saisie libre (avec suggestions) : deux orthographes différentes donnent deux valeurs de filtre.
