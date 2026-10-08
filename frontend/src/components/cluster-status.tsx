import { Status, type StatusTone } from "@/components/ui";

const STATUS: Record<string, [StatusTone, string]> = {
  online: ["ok", "Online"],
  offline: ["error", "Offline"],
  auth_error: ["error", "Erro de autenticação"],
  error: ["error", "Erro"],
  unknown: ["unknown", "Não verificado"],
};

export function ClusterStatus({ status }: { status: string }) {
  const [tone, label] = STATUS[status] ?? ["unknown", status];
  return <Status tone={tone}>{label}</Status>;
}
