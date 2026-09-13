import "server-only";

export const publicAuthConfigured = () =>
  Boolean(
    process.env.NEXT_PUBLIC_PRIVY_APP_ID &&
    process.env.PRIVY_APP_SECRET &&
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );

export function required(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`The ${name} integration is not configured.`);
  }

  return value;
}

export function siteUrl() {
  return process.env.SCOUT_SITE_URL ?? "http://localhost:3000";
}
