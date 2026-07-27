/**
 * Team-invitation constants. A team invite (owner adds a member → emailed
 * /join link → member sets their own password) is single-use and expires
 * after this many days, mirroring the beta-application invite TTL.
 */
export const TEAM_INVITE_TTL_DAYS = 7;

export const TEAM_INVITE_TTL_MS = TEAM_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;
