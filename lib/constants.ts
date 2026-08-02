// lib/constants.ts
// Dependency-free constants shared by the edge middleware/proxy, server libs, and
// pages. Kept import-free on purpose: the auth perimeter runs on the edge runtime,
// so it must not pull in the Neon client just to read a string.
export const ADMIN_EMAIL = 'david.dyer.24@gmail.com'
