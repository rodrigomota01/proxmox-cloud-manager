import { redirect } from "next/navigation";

/** Connections are managed from the Hypervisors page now; keep old links working. */
export default function ClustersPage() {
  redirect("/admin/nodes");
}
