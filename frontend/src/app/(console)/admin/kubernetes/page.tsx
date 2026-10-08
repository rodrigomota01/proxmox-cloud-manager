"use client";

import { K8sClusterList } from "@/components/k8s-cluster-list";

export default function AdminKubernetesPage() {
  return <K8sClusterList mode="admin" />;
}
