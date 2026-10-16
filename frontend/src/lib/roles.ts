import { translate, type MessageKey } from "@/lib/i18n";

/** Role names (API) -> how people read them. Scope rules come from GET /roles. */
export const ROLE_INFO: Record<string, { label: MessageKey; hint: MessageKey }> = {
  TENANT_ADMIN: { label: "access.roles.tenantAdmin", hint: "access.roles.tenantAdminHint" },
  PROJECT_ADMIN: { label: "access.roles.projectAdmin", hint: "access.roles.projectAdminHint" },
  USER: { label: "access.roles.user", hint: "access.roles.userHint" },
  OPERATOR: { label: "access.roles.operator", hint: "access.roles.operatorHint" },
  READ_ONLY: { label: "access.roles.readOnly", hint: "access.roles.readOnlyHint" },
  SUPER_ADMIN: { label: "access.roles.superAdmin", hint: "access.roles.superAdminHint" },
  PLATFORM_ADMIN: { label: "access.roles.platformAdmin", hint: "access.roles.platformAdminHint" },
};

/** Call while rendering: the text follows the current language. */
export const roleLabel = (name: string) => (ROLE_INFO[name] ? translate(ROLE_INFO[name].label) : name);
export const roleHint = (name: string) => (ROLE_INFO[name] ? translate(ROLE_INFO[name].hint) : undefined);
