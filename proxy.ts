// proxy.ts  (renamed from middleware.ts for Next 16 — the `middleware` file
//            convention is deprecated; `proxy` is the replacement. Contents are
//            unchanged apart from importing ADMIN_EMAIL from lib/constants.)
// HARDENED — email-claim fallback + case-insensitive allowlist
// Change vs. prior version:
//   1. If sessionClaims.email is missing (stale token / certain OAuth paths),
//      fall back to resolving the primary email from Clerk by userId instead
//      of hard-redirecting to /not-authorized. This runs ONLY when the claim
//      is absent, so the normal fast path stays claim-only (no per-request
//      Clerk call for the common case).
//   2. Allowlist match is now case-insensitive (lower() both sides).
import { clerkMiddleware, createRouteMatcher, clerkClient } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { neon } from '@neondatabase/serverless'
import { ADMIN_EMAIL } from '@/lib/constants'

// '/' is exact — only the homepage is public, not everything under it.
const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/not-authorized',
])

export default clerkMiddleware(async (auth, req) => {
  if (isPublicRoute(req)) return

  const { userId, redirectToSignIn, sessionClaims } = await auth()
  if (!userId) return redirectToSignIn()

  // Primary path: email from the session-token custom claim.
  let email = (sessionClaims?.email as string | undefined)?.toLowerCase()

  // Fallback: token didn't carry the claim (e.g. minted before the claim was
  // added, or via an OAuth path that didn't populate it). Resolve directly
  // from Clerk rather than locking out a user who is legitimately allowed.
  if (!email) {
    try {
      const client = await clerkClient()
      const user = await client.users.getUser(userId)
      email = user.primaryEmailAddress?.emailAddress?.toLowerCase()
    } catch (error) {
      console.error('Clerk user lookup failed:', error)
    }
  }

  if (!email) return NextResponse.redirect(new URL('/not-authorized', req.url))

  if (email === ADMIN_EMAIL) return

  try {
    const sql = neon(process.env.DATABASE_URL!)
    const result = await sql`
      SELECT email FROM allowed_users WHERE lower(email) = ${email} LIMIT 1`
    if (result.length === 0) {
      return NextResponse.redirect(new URL('/not-authorized', req.url))
    }
  } catch (error) {
    console.error('DB allowlist check failed:', error)
    return NextResponse.redirect(new URL('/not-authorized', req.url))
  }
})

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
