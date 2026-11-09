import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | undefined;
let recoveryClientCount = 0;

function getPublicAuthConfig() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) throw new Error("Supabase Auth public configuration is missing.");
    return { url, key };
}

export function getBrowserAuth(): SupabaseClient {
    if (client) return client;
    const { url, key } = getPublicAuthConfig();
    client = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } });
    return client;
}

export function createRecoveryAuth(): SupabaseClient {
    const { url, key } = getPublicAuthConfig();
    return createClient(url, key, {
        auth: {
            storageKey: `efin-dms-password-recovery-${++recoveryClientCount}`,
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false,
        },
    });
}
