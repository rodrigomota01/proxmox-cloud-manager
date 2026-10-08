"use client";

import { K8sClusterDetail } from "@/components/k8s-cluster-detail";
import { NoTenant } from "@/components/no-tenant";
import { useSession } from "@/lib/session";

export default function K8sClusterPage() {
  const { tenantId } = useSession();
  if (!tenantId) return <NoTenant />;
  return <K8sClusterDetail mode="tenant" />;
}
