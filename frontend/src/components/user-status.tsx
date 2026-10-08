import { Status } from "@/components/ui";
import type { Schemas } from "@/lib/api/client";

export function UserStatus({ user }: { user: Schemas["AdminUserOut"] }) {
  if (!user.is_active) return <Status tone="off">Desativado</Status>;
  if (user.locked) return <Status tone="error" icon="ban">Bloqueado</Status>;
  if (user.invited) return <Status tone="info" icon="history">Convidado</Status>;
  return <Status tone="ok">Ativo</Status>;
}
