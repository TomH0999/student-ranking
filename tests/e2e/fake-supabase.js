/**
 * Faux client Supabase pour les tests de bout en bout : servi à la place de
 * assets/vendor/supabase/supabase.js. Même surface que celle utilisée par js/api.js.
 * L'état initial vient de window.__FAKE_INIT ; les tests pilotent window.__fake.
 */
(() => {
    const init = window.__FAKE_INIT || {};
    const KEY = "gdn-supabase-auth";
    const fake = {
        users: init.users || {}, // email → { id, password }
        profiles: new Map(Object.entries(init.profiles || {})), // userId → display_name | null
        students: init.students || [], // lignes de ranking_snapshot(), avec owner = userId
        installed: init.installed !== false,
        failSnapshot: false,
        channelStatus: null,
        pulseListeners: [],
        authListeners: [],
        calls: { snapshot: 0 },
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

    function nameError(userId, name) {
        if (name === null) return null;
        if (name.length < 2 || name.length > 24) return { code: "23514", message: "check constraint" };
        for (const [other, existing] of fake.profiles) {
            if (other !== userId && existing && existing.toLowerCase() === name.toLowerCase()) return { code: "23505", message: "duplicate key" };
        }
        return null;
    }

    function profiles() {
        return {
            select: () => ({
                eq: (_c, userId) => ({
                    maybeSingle: () => {
                        if (!fake.installed) return fail(notInstalled);
                        return ok(fake.profiles.has(userId) && userId === uid() ? { display_name: fake.profiles.get(userId) } : null);
                    }
                })
            }),
            // Comme la vraie base : pas de droit de mise à jour sur user_id, donc l'upsert est refusé
            upsert: () => fail({ code: "42501", message: "permission denied for table ranking_profiles" }),
            insert: (row) => {
                if (!fake.installed) return fail(notInstalled);
                if (fake.profiles.has(row.user_id)) return fail({ code: "23505", message: 'duplicate key value violates unique constraint "ranking_profiles_pkey"' });
                const err = nameError(row.user_id, row.display_name);
                if (err) return fail(err);
                fake.profiles.set(row.user_id, row.display_name);
                return ok(null);
            },
            update: (patch) => ({
                eq: (_c, userId) => {
                    const err = nameError(userId, patch.display_name);
                    if (err) return fail(err);
                    fake.profiles.set(userId, patch.display_name);
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

    function snapshot() {
        fake.calls.snapshot++;
        if (!fake.installed) return fail({ code: "PGRST202", message: "Could not find the function public.ranking_snapshot" });
        if (fake.failSnapshot) return Promise.reject(new TypeError("Failed to fetch"));
        const me = uid();
        if (!fake.profiles.has(me)) return ok([]);
        const rows = fake.students
            .filter((s) => fake.profiles.has(s.owner))
            .map((s) => ({
                student_key: `k-${s.owner}`,
                display_name: fake.profiles.get(s.owner) || `Étudiant ${s.owner.slice(0, 4).toUpperCase()}`,
                is_me: s.owner === me,
                subject_averages: s.subjects || {},
                ue_averages: s.ues || {},
                general_average: s.general
            }));
        return ok(rows);
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
                from: () => profiles(),
                rpc: () => snapshot(),
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
