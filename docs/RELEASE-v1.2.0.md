Listes fermées pour la classe et le groupe TD, et suppression de son compte avec sauvegarde automatique.

Installation, mise à jour et mode d'emploi : [README](https://github.com/TomH0999/student-ranking#readme).

## Nouveautés

**Classe et groupe TD en liste fermée**
- Classe : S1, S2, S3, S4, S5, S6, S7. Groupe TD : TD1, TD2.
- Fini les variantes d'orthographe : les filtres regroupent correctement tout le monde.

**Supprimer mon compte**
- Bouton en bas de « Mon profil ».
- Une sauvegarde JSON est téléchargée automatiquement avant toute suppression : notes, devoirs, réglages et profil. Elle est au format du gestionnaire de scolarité et peut y être réimportée (Réglages → Importer).
- Confirmation en écrivant `SUPPRIMER`. Si la sauvegarde échoue, la suppression reste bloquée.
- Efface définitivement de la base : le compte, toutes ses notes, devoirs et réglages synchronisés, son profil et sa place dans le classement. Les autres inscrits voient le classement se mettre à jour en direct.

## Compatibilité

- `supabase/ranking.sql` est **à réexécuter avant** de publier le site.
- Une classe ou un groupe saisi librement en v1.1 et absent des listes est effacé du profil ; l'étudiant le choisit de nouveau. Le reste du profil, les moyennes et les rangs ne changent pas.

## À savoir

- La suppression concerne le compte partagé avec le gestionnaire de scolarité : après coup, il n'est plus possible de s'y connecter non plus. Les données déjà présentes sur les appareils y restent, en mode local.
- Le lien personnel d'emploi du temps n'est pas inclus dans la sauvegarde, comme dans les exports du gestionnaire.
- Programme du semestre 1 uniquement ; notes et profils déclaratifs.
