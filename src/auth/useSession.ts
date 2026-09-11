// Session gate for the whole app. The MVP is single-user personal software: no sign-up
// UI, no password reset — just "is there a session" so RLS-governed writes have a user.
import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { getSupabase } from "../db/client";

export function useSession(): { session: Session | null; loading: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  // G7: the client now arrives asynchronously (src/db/client.ts loads
  // `@supabase/supabase-js` off the critical path), so this resolves a session
  // slightly later than it used to. That is safe by design — src/App.tsx
  // renders the map before any session exists and only gates the sign-in
  // affordance on `loading`.
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      const supabase = await getSupabase();
      if (cancelled) return;

      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      setSession(data.session);
      setLoading(false);

      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((_event, newSession) => {
        setSession(newSession);
      });
      unsubscribe = () => subscription.unsubscribe();
      // Unmounting between the await above and here would otherwise leak the
      // subscription — the cleanup below has already run by then.
      if (cancelled) unsubscribe();
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  return { session, loading };
}
