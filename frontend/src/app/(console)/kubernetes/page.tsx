"use client";

import { K8sClusterList } from "@/components/k8s-cluster-list";
import { NoTenant } from "@/components/no-tenant";
import { useSession } from "@/lib/session";

export default function KubernetesPage() {
  const { tenantId } = useSession();
  if (!tenantId) return <NoTenant />;
  return <K8sClusterList mode="tenant" />;
}
