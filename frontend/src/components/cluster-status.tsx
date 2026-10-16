import { Status, type StatusTone } from "@/components/ui";
import { type MessageKey, useT } from "@/lib/i18n";

// "Online" and "Offline" read the same in every language
const STATUS: Record<string, [StatusTone, MessageKey | { text: string }]> = {
  online: ["ok", { text: "Online" }],
  offline: ["error", { text: "Offline" }],
  auth_error: ["error", "k8s.clusterStatus.authError"],
  error: ["error", "k8s.clusterStatus.error"],
  unknown: ["unknown", "k8s.clusterStatus.unknown"],
};

export function ClusterStatus({ status }: { status: string }) {
  const t = useT();
  const [tone, label] = STATUS[status] ?? ["unknown", { text: status }];
  return <Status tone={tone}>{typeof label === "string" ? t(label) : label.text}</Status>;
}
