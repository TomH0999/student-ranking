/**
 * Accès Supabase du classement : session (partagée avec le gestionnaire de scolarité
 * quand les deux sites sont sur la même origine), profil, moyennes, signal temps réel.
 * Seule la clé publique est utilisée ; la base applique la RLS.
 */

/** Même clé de stockage que l'application : connecté là-bas = connecté ici (même origine). */
export const AUTH_STORAGE_KEY = "gdn-supabase-auth";

export class RankingError extends Error {
    constructor(kind, message) {
        super(message);
        this.kind = kind; // "auth" | "network" | "not-installed" | "name-taken" | "name-invalid" | "server"
    }
}

function mapError(error) {
    if (error instanceof RankingError) return error;
    const code = error && error.code ? String(error.code) : "";
    const status = error && error.status;
    const message = error && error.message ? String(error.message) : String(error);
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) {
        return new RankingError("network", "Connexion impossible. Vérifiez votre accès à Internet.");
    }
    if (code === "PGRST202" && /ranking_(delete_account|student_grades)/.test(message)) {
        return new RankingError("not-installed", "Le classement installé sur Supabase est plus ancien que ce site : réexécutez supabase/ranking.sql (voir le README).");
    }
    if (code === "PGRST202" || code === "PGRST205" || code === "42P01" || code === "42883") {
        return new RankingError("not-installed", "Le classement n'est pas encore installé sur ce projet Supabase (exécutez supabase/ranking.sql, voir le README).");
    }
    if (code === "23505") return new RankingError("name-taken", "Ce pseudo est déjà pris.");
    if (code === "23514") {
        if (/ranking_profiles_details_check/.test(message)) return new RankingError("profile-invalid", "Une information du profil a été refusée. Vérifiez les champs.");
        return new RankingError("name-invalid", "Pseudo refusé (2 à 24 caractères, sans « Étudiant » au début).");
    }
    if (code === "42703" || code === "PGRST204") {
        return new RankingError("not-installed", "Le classement installé sur Supabase est plus ancien que ce site : réexécutez supabase/ranking.sql (voir le README).");
    }
    if (code === "invalid_credentials" || /invalid login credentials/i.test(message)) {
        return new RankingError("auth", "Adresse e-mail ou mot de passe incorrect.");
    }
    if (code === "email_not_confirmed" || /email not confirmed/i.test(message)) {
        return new RankingError("auth", "Adresse e-mail non confirmée : ouvrez le lien reçu par e-mail.");
    }
    if (status === 401 || code === "PGRST301" || /jwt/i.test(message)) {
        return new RankingError("auth", "Session expirée : reconnectez-vous.");
    }
    return new RankingError("server", message || "Erreur du serveur.");
}

/** Colonnes du profil ↔ champs utilisés par l'interface. */
const PROFILE_COLUMNS = {
    displayName: "display_name",
    firstName: "first_name",
    lastName: "last_name",
    nameMode: "name_mode",
    studentNumber: "student_number",
    origin: "origin",
    className: "class_name",
    tdGroup: "td_group",
    track: "track",
    showOrigin: "show_origin",
    showClass: "show_class",
    showTdGroup: "show_td_group",
    showTrack: "show_track",
    showStudentNumber: "show_student_number",
    showGrades: "show_grades"
};

function toProfile(row) {
    const profile = {};
    for (const [field, column] of Object.entries(PROFILE_COLUMNS)) profile[field] = row[column] === undefined ? null : row[column];
    return profile;
}

function toRow(profile) {
    const row = {};
    for (const [field, column] of Object.entries(PROFILE_COLUMNS)) if (field in profile) row[column] = profile[field];
    return row;
}

const toSession = (s) => (s && s.user ? { userId: s.user.id, email: s.user.email || "" } : null);

export function createApi(config, supabaseLib = globalThis.supabase) {
    const client = supabaseLib.createClient(config.supabaseUrl, config.supabaseKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: AUTH_STORAGE_KEY },
        realtime: { params: { eventsPerSecond: 10 } }
    });
    let channel = null;

    async function run(promise) {
        let result;
        try {
            result = await promise;
        } catch (e) {
            throw mapError(e);
        }
        if (result.error) throw mapError(result.error);
        return result.data;
    }

    return {
        async getSession() {
            const data = await run(client.auth.getSession());
            return toSession(data.session);
        },

        /** listener(session | null) ; jamais d'appel Supabase dans le rappel lui-même. */
        onAuthChange(listener) {
            const { data } = client.auth.onAuthStateChange((event, session) => {
                setTimeout(() => listener(toSession(session), event), 0);
            });
            return () => data.subscription.unsubscribe();
        },

        async signIn(email, password) {
            const data = await run(client.auth.signInWithPassword({ email: String(email).trim(), password }));
            const s = toSession(data.session);
            if (!s) throw new RankingError("auth", "Connexion impossible.");
            return s;
        },

        async signOut() {
            try {
                await client.auth.signOut({ scope: "local" });
            } catch {
                /* déconnexion locale quoi qu'il arrive */
            }
        },

        /** Profil de l'utilisateur connecté, ou null s'il n'est pas inscrit au classement. */
        async fetchProfile(userId) {
            const row = await run(client.from("ranking_profiles").select(Object.values(PROFILE_COLUMNS).join(",")).eq("user_id", userId).maybeSingle());
            return row ? toProfile(row) : null;
        },

        /**
         * Insertion simple (pas d'upsert : la base n'autorise la mise à jour que du pseudo).
         * Déjà inscrit depuis un autre appareil : on met simplement le pseudo à jour.
         */
        async join(userId, displayName) {
            const { error } = await client.from("ranking_profiles").insert({ user_id: userId, display_name: displayName });
            if (error && !(String(error.code) === "23505" && /ranking_profiles_pkey/.test(String(error.message)))) throw mapError(error);
            if (error) await this.saveProfile(userId, { displayName });
            return this.fetchProfile(userId);
        },

        /** Enregistre tout ou partie du profil, puis renvoie le profil tel qu'il est en base. */
        async saveProfile(userId, profile) {
            await run(client.from("ranking_profiles").update(toRow(profile)).eq("user_id", userId));
            return this.fetchProfile(userId);
        },

        /** Détail des notes d'un étudiant : vide s'il ne le partage pas. */
        async studentGrades(studentKey) {
            return run(client.rpc("ranking_student_grades", { p_student_key: studentKey }));
        },

        async leave(userId) {
            await run(client.from("ranking_profiles").delete().eq("user_id", userId));
        },

        /**
         * Toutes les données vivantes du compte dans la table de l'application (notes, devoirs,
         * réglages), lues page par page : la RLS ne renvoie que les lignes de l'utilisateur.
         */
        async exportItems() {
            const PAGE = 1000;
            const rows = [];
            for (let from = 0; ; from += PAGE) {
                const page = await run(client.from("items").select("id,collection,data").is("deleted_at", null).order("id").range(from, from + PAGE - 1));
                rows.push(...page);
                if (page.length < PAGE) return rows;
            }
        },

        /** Supprime définitivement le compte et toutes ses données (cascade côté base). */
        async deleteAccount() {
            await run(client.rpc("ranking_delete_account"));
        },

        async snapshot() {
            return run(client.rpc("ranking_snapshot"));
        },

        /** onPulse() à chaque changement du classement ; onState("live" | "connecting" | "offline"). */
        subscribe(onPulse, onState) {
            this.unsubscribe();
            const current = client
                .channel("ranking-pulse")
                .on("postgres_changes", { event: "*", schema: "public", table: "ranking_pulse" }, () => onPulse())
                .subscribe((status) => {
                    if (current !== channel) return;
                    if (status === "SUBSCRIBED") onState("live");
                    else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") onState("offline");
                    else onState("connecting");
                });
            channel = current;
        },

        unsubscribe() {
            if (!channel) return;
            const old = channel;
            channel = null;
            try {
                client.removeChannel(old);
            } catch {
                /* canal déjà fermé */
            }
        }
    };
}
