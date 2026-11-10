/**
 * Configuration publique du classement (lue par le navigateur, servie par GitHub Pages).
 *
 * Mettez ici les MÊMES valeurs que dans le config.js du gestionnaire de scolarité :
 * le classement lit les notes du même projet Supabase.
 *
 *  supabaseUrl : Supabase → Project Settings → API → Project URL
 *  supabaseKey : clé PUBLIQUE (« publishable », sb_publishable_…, ou « anon » historique)
 *  appUrl      : adresse du gestionnaire de scolarité (lien « Ouvrir l'application »)
 *
 * La clé publique PEUT être publiée : la sécurité repose sur la connexion et la RLS.
 * Ne mettez JAMAIS ici la clé « secret » (sb_secret_…) ni « service_role ».
 */
window.RANKING_CONFIG = {
    supabaseUrl: "https://wcdjcpcmavbslwmicosx.supabase.co",
    supabaseKey: "sb_publishable_BAHiz2mhBcvt9Sja0u7MqQ_ZcMZz0l2",
    appUrl: "https://tomh0999.github.io/gestionnaire_de_notes/"
};
