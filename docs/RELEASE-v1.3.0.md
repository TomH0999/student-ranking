Semestres S1 à S6 pour le classement du BUT Informatique.

Installation, mise à jour et mode d'emploi : [README](https://github.com/TomH0999/student-ranking#readme).

## Nouveautés

**Semestres 1 à 6**
- Barre « Tous / S1 … S6 » : chaque semestre a son classement sur la moyenne générale, les UE et les matières.
- Coefficients des MCCC 2025-2026 de l'IUT (site de Montpellier), identiques au gestionnaire de scolarité v2.1.
- À partir du S4, moyennes calculées selon le parcours (RACDV, DACS, IAMSI) choisi dans le gestionnaire. Le parcours d'un étudiant n'est jamais montré aux autres.
- Un semestre sans aucune moyenne est grisé.

**Tous les semestres**
- Classement sur la moyenne globale (moyenne simple des semestres calculés).
- Classement par compétence (moyenne des UE de la compétence, tous semestres).
- La fiche d'un étudiant montre sa moyenne globale et la moyenne de chaque semestre.

**Calcul**
- Moyennes identiques au bit près à celles du gestionnaire, semestre par semestre (vérifié sur 30 étudiants aléatoires, tous parcours, plus le S1 sur 40 étudiants).
- À partir du S2, calcul par modules comme dans les MCCC ; le S1 reste calculé comme avant.

## Correction (version 1.2.1, publiée avec celle-ci)
- Le classement cessait de se mettre à jour en direct après le choix d'un filtre, tant qu'on ne cliquait pas ailleurs.

## Compatibilité
- `supabase/ranking.sql` est **à réexécuter avant** de publier le site. Il ajoute la table du programme et met à jour les fonctions, sans toucher aux inscrits ni aux profils.
- Le site v1.2 continue de fonctionner avec la base mise à jour (il n'affiche que le S1).
- Les moyennes du S1 et les rangs actuels ne changent pas.

## Limites connues
- Coefficients de l'année 2025-2026 (site de Montpellier, formation initiale) : à mettre à jour si les MCCC changent.
- Deux coefficients du S4 sont déduits (cases coupées dans le PDF des MCCC) : RACDV UE 4.3 et DACS UE 4.4.
- Notes et profils déclaratifs : rien n'est vérifié.
