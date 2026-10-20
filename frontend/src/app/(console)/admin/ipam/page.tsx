"use client";

import { Suspense } from "react";

import { IpamRegistry } from "@/components/admin/ipam-registry";

export default function IpamRegistryPage() {
  return (
    <Suspense fallback={null}>
      <IpamRegistry />
    </Suspense>
  );
}
