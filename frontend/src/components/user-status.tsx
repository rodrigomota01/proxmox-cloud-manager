import { Badge } from "@/components/ui";
import type { Schemas } from "@/lib/api/client";

export function UserStatus({ user }: { user: Schemas["AdminUserOut"] }) {
  if (!user.is_active) return <Badge tone="red">Desativado</Badge>;
  if (user.locked) return <Badge tone="amber">Bloqueado</Badge>;
  if (user.invited) return <Badge tone="blue">Convidado</Badge>;
  return <Badge tone="green">Ativo</Badge>;
}
