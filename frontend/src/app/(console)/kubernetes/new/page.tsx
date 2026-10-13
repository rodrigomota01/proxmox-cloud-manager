"use client";

import { K8sCreateForm } from "@/components/k8s-create";
import { NoTenant } from "@/components/no-tenant";
import { useSession } from "@/lib/session";

export default function NewK8sClusterPage() {
  const { tenantId } = useSession();
  if (!tenantId) return <NoTenant />;
  return <K8sCreateForm mode="tenant" />;
}
