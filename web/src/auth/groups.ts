import { decodeJwtPayload } from "./tokens";

export const ADMIN_GROUP = "admins";

export function isAdminToken(idToken: string): boolean {
  const groups = decodeJwtPayload(idToken)["cognito:groups"];
  return Array.isArray(groups) && groups.map(String).includes(ADMIN_GROUP);
}
