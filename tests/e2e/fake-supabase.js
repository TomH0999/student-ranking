/**
 * Faux client Supabase pour les tests de bout en bout : servi à la place de
 * assets/vendor/supabase/supabase.js. Même surface que celle utilisée par js/api.js.
 * L'état initial vient de window.__FAKE_INIT ; les tests pilotent window.__fake.
 */
(() => {
    const init = window.__FAKE_INIT || {};
    const KEY = "gdn-supabase-auth";
    const DEFAULTS = {
        display_name: null, first_name: null, last_name: null, name_mode: "pseudo", student_number: null,
        origin: null, class_name: null, td_group: null, track: null,
        show_origin: true, show_class: true, show_td_group: true, show_track: true, show_student_number: false, show_grades: false
    };
    // init.profiles : userId → pseudo (texte ou null), ou objet de colonnes
    const toRow = (v) => ({ ...DEFAULTS, ...(v && typeof v === "object" ? v : { display_name: v }) });
    const fake = {
        users: init.users || {}, // email → { id, password }
        profiles: new Map(Object.entries(init.profiles || {}).map(([id, v]) => [id, toRow(v)])),
        students: init.students || [], // { owner, general, ues, subjects, grades? }
        items: init.items || [], // lignes de la table items : { user_id, id, collection, data, deleted_at? }
        deleted: [], // comptes supprimés
        failExport: false,
        failDelete: false,
        installed: init.installed !== false,
        failSnapshot: false,
        channelStatus: null,
        pulseListeners: [],
        authListeners: [],
        calls: { snapshot: 0, grades: 0 },
        setProfile(userId, patch) {
            this.profiles.set(userId, { ...(this.profiles.get(userId) || toRow(null)), ...patch });
        },
        pulse() {
            for (const l of this.pulseListeners) l({});
        },
        setStatus(status) {
            if (this.channelStatus) this.channelStatus(status);
        }
    };
    window.__fake = fake;

    const session = () => {
        try {
            return JSON.parse(localStorage.getItem(KEY));
        } catch {
            return null;
        }
    };
    const uid = () => (session() ? session().user.id : null);
    const notInstalled = { code: "PGRST205", message: "Could not find the table 'public.ranking_profiles' in the schema cache" };
    const ok = (data) => Promise.resolve({ data, error: null });
    const fail = (error) => Promise.resolve({ data: null, error });

    // Mêmes règles que les contraintes SQL (versions simplifiées)
    function rowError(userId, row) {
        const name = row.display_name;
        if (name !== null && name !== undefined) {
            if (name.length < 2 || name.length > 24) return { code: "23514", message: 'violates check constraint "ranking_profiles_name_check"' };
            for (const [other, existing] of fake.profiles) {
                if (other !== userId && existing.display_name && existing.display_name.toLowerCase() === name.toLowerCase()) return { code: "23505", message: 'duplicate key value violates unique constraint "ranking_profiles_name_key"' };
            }
        }
        const bad =
            (row.class_name && !["S1", "S2", "S3", "S4", "S5", "S6", "S7"].includes(row.class_name)) ||
            (row.td_group && !["TD1", "TD2"].includes(row.td_group)) ||
            (row.student_number && !/^[0-9A-Za-z]{1,20}$/.test(row.student_number)) ||
            (row.origin && !["general", "sti2d", "autre"].includes(row.origin)) ||
            (row.track && !["racdv", "dacs", "aged", "iamsi", "indecis", "autre"].includes(row.track));
        return bad ? { code: "23514", message: 'violates check constraint "ranking_profiles_details_check"' } : null;
    }

    function profiles() {
        return {
            select: () => ({
                eq: (_c, userId) => ({
                    maybeSingle: () => {
                        if (!fake.installed) return fail(notInstalled);
                        return ok(fake.profiles.has(userId) && userId === uid() ? { ...fake.profiles.get(userId) } : null);
                    }
                })
            }),
            // Comme la vraie base : pas de droit de mise à jour sur user_id, donc l'upsert est refusé
            upsert: () => fail({ code: "42501", message: "permission denied for table ranking_profiles" }),
            insert: (row) => {
                if (!fake.installed) return fail(notInstalled);
                if (fake.profiles.has(row.user_id)) return fail({ code: "23505", message: 'duplicate key value violates unique constraint "ranking_profiles_pkey"' });
                const { user_id, ...columns } = row;
                const err = rowError(user_id, columns);
                if (err) return fail(err);
                fake.profiles.set(user_id, toRow(columns));
                return ok(null);
            },
            update: (patch) => ({
                eq: (_c, userId) => {
                    const err = rowError(userId, patch);
                    if (err) return fail(err);
                    fake.setProfile(userId, patch);
                    return ok(null);
                }
            }),
            delete: () => ({
                eq: (_c, userId) => {
                    fake.profiles.delete(userId);
                    return ok(null);
                }
            })
        };
    }

    // Table items de l'application : la RLS ne renvoie que les lignes de l'utilisateur connecté
    function items() {
        let rows = fake.items.filter((r) => r.user_id === uid());
        const chain = {
            select: () => chain,
            is: (column, value) => {
                rows = rows.filter((r) => (r[column] ?? null) === value);
                return chain;
            },
            order: () => chain,
            range: (from, to) => {
                if (fake.failExport) return Promise.reject(new TypeError("Failed to fetch"));
                return ok(rows.slice(from, to + 1).map(({ id, collection, data }) => ({ id, collection, data })));
            }
        };
        return chain;
    }

    function deleteAccount() {
        const me = uid();
        if (!me) return fail({ code: "42501", message: "Connexion requise." });
        if (fake.failDelete) return fail({ code: "PGRST202", message: "Could not find the function public.ranking_delete_account without parameters in the schema cache" });
        fake.deleted.push(me);
        fake.profiles.delete(me);
        fake.items = fake.items.filter((r) => r.user_id !== me);
        fake.students = fake.students.filter((s) => s.owner !== me);
        for (const [email, user] of Object.entries(fake.users)) if (user.id === me) delete fake.users[email];
        return ok(null);
    }

    const keyOf = (owner) => `k-${owner}`;

    function snapshot() {
        fake.calls.snapshot++;
        if (!fake.installed) return fail({ code: "PGRST202", message: "Could not find the function public.ranking_snapshot" });
        if (fake.failSnapshot) return Promise.reject(new TypeError("Failed to fetch"));
        const me = uid();
        if (!fake.profiles.has(me)) return ok([]);
        const rows = fake.students
            .filter((s) => fake.profiles.has(s.owner))
            .map((s) => {
                const p = fake.profiles.get(s.owner);
                const real = p.name_mode === "real" ? [p.first_name, p.last_name].filter(Boolean).join(" ") : "";
                return {
                    student_key: keyOf(s.owner),
                    display_name: real || p.display_name || `Étudiant ${s.owner.slice(0, 4).toUpperCase()}`,
                    is_me: s.owner === me,
                    subject_averages: s.subjects || {},
                    ue_averages: s.ues || {},
                    general_average: s.general,
                    origin: p.show_origin ? p.origin : null,
                    class_name: p.show_class ? p.class_name : null,
                    td_group: p.show_td_group ? p.td_group : null,
                    track: p.show_track ? p.track : null,
                    student_number: p.show_student_number ? p.student_number : null,
                    shares_grades: p.show_grades
                };
            });
        return ok(rows);
    }

    function grades(args) {
        fake.calls.grades++;
        const me = uid();
        if (!fake.profiles.has(me)) return ok([]);
        const s = fake.students.find((x) => keyOf(x.owner) === args.p_student_key);
        const p = s && fake.profiles.get(s.owner);
        if (!p || !(p.show_grades || s.owner === me)) return ok([]);
        return ok((s.grades || []).map((g) => ({ ...g })));
    }

    window.supabase = {
        createClient() {
            return {
                auth: {
                    getSession: () => ok({ session: session() }),
                    onAuthStateChange(listener) {
                        fake.authListeners.push(listener);
                        return { data: { subscription: { unsubscribe() {} } } };
                    },
                    signInWithPassword({ email, password }) {
                        const user = fake.users[email];
                        if (!user || user.password !== password) return fail({ code: "invalid_credentials", message: "Invalid login credentials", status: 400 });
                        const s = { access_token: "t", user: { id: user.id, email } };
                        localStorage.setItem(KEY, JSON.stringify(s));
                        for (const l of fake.authListeners) l("SIGNED_IN", s);
                        return ok({ session: s });
                    },
                    signOut() {
                        localStorage.removeItem(KEY);
                        for (const l of fake.authListeners) l("SIGNED_OUT", null);
                        return ok(null);
                    }
                },
                from: (table) => (table === "items" ? items() : profiles()),
                rpc: (name, args) => (name === "ranking_student_grades" ? grades(args || {}) : name === "ranking_delete_account" ? deleteAccount() : snapshot()),
                channel() {
                    const ch = {
                        on(_type, _filter, listener) {
                            fake.pulseListeners.push(listener);
                            return ch;
                        },
                        subscribe(cb) {
                            fake.channelStatus = cb;
                            setTimeout(() => cb(init.offline ? "CHANNEL_ERROR" : "SUBSCRIBED"), 0);
                            return ch;
                        }
                    };
                    return ch;
                },
                removeChannel() {
                    fake.pulseListeners = [];
                    fake.channelStatus = null;
                }
            };
        }
    };
})();
