Correction du direct après l'usage d'un filtre.

## Correction

- **Le classement cessait de se mettre à jour en direct après le choix d'un filtre** (classe, groupe TD, provenance, parcours), tant qu'on ne cliquait ou n'appuyait pas ailleurs sur la page. Les moyennes et les rangs affichés pouvaient donc être en retard, alors que la pastille indiquait « En direct ». Présent depuis la v1.1.0.
- La barre de filtres reste désormais en place pendant les mises à jour : le classement se rafraîchit autour d'elle, et une liste ouverte n'est plus refermée.

## Compatibilité

- Aucun changement dans la base : `supabase/ranking.sql` n'a pas à être réexécuté.
- Aucun changement pour les profils, les moyennes ni les rangs.
