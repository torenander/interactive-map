import { useEffect, useState } from 'react'
import MapShell from './map/MapShell'
import SignIn from './auth/SignIn'
import { useSession } from './auth/useSession'
import { signOut } from './db/client'

// The map itself needs no auth — it is a self-hosted basemap, and G1's regression test
// (tests/e2e/map-shell.spec.ts, out of scope to touch) exercises it with no session at
// all: canvas, viewport, attribution and the geolocate control all have to work signed
// out. So MapShell always mounts; only areas/save/delete need a session, and those calls
// already handle "no session" gracefully (fetchAreas returns [], save/delete surface an
// auth error). Sign-in is a small top-right affordance, not a full-screen gate.
export default function App() {
  const { session, loading } = useSession()
  const [showSignIn, setShowSignIn] = useState(false)

  useEffect(() => {
    if (session) setShowSignIn(false)
  }, [session])

  return (
    <div className="relative h-full w-full">
      <MapShell />

      {!loading && (
        <div className="absolute right-3 top-3 z-20">
          {session ? (
            <button
              type="button"
              onClick={() => void signOut()}
              className="rounded-full bg-white/90 px-3 py-1 text-xs text-gray-600 shadow"
            >
              Sign out
            </button>
          ) : (
            <button
              type="button"
              data-testid="open-sign-in"
              onClick={() => setShowSignIn(true)}
              className="rounded-full bg-white/90 px-3 py-1 text-xs text-gray-600 shadow"
            >
              Sign in
            </button>
          )}
        </div>
      )}

      {showSignIn && !session && (
        <div className="absolute inset-0 z-30">
          <SignIn />
        </div>
      )}
    </div>
  )
}
