import { Badge } from "@/components/ui";

const STATUS_TONE = { online: "green", offline: "red", auth_error: "red", error: "red", unknown: "gray" } as const;
const STATUS_LABEL: Record<string, string> = {
  online: "Online",
  offline: "Offline",
  auth_error: "Erro de autenticação",
  error: "Erro",
  unknown: "Não verificado",
};

export function ClusterStatus({ status }: { status: string }) {
  return (
    <Badge tone={STATUS_TONE[status as keyof typeof STATUS_TONE] ?? "gray"}>
      {STATUS_LABEL[status] ?? status}
    </Badge>
  );
}
