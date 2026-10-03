"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";

import { ConnectionInstances, ConnectionSettings } from "@/components/admin/connection";
import { ErrorBox } from "@/components/ui";
import { api, errorMessage, unwrap } from "@/lib/api/client";

/** A connection is shown on its own page only while it has no node yet (never synced,
 * bad token) or when it is a real multi-node cluster. A single-server connection lives
 * in that server's page, under "Configuração". */
export default function ConnectionPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const cluster = useQuery({
    queryKey: ["admin", "cluster", id],
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/admin/clusters/{cluster_id}", { params: { path: { cluster_id: id } } })),
    refetchInterval: 15_000,
  });
  const nodes = useQuery({
    queryKey: ["admin", "nodes"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/nodes")),
    refetchInterval: 15_000,
  });
  const mine = (nodes.data ?? []).filter((n) => n.cluster_id === id);
  const single = mine.length === 1 ? mine[0].id : null;

  useEffect(() => {
    if (single) router.replace(`/admin/nodes/${single}?tab=config`);
  }, [single, router]);

  if (cluster.isError) return <ErrorBox message={errorMessage(cluster.error)} />;
  const c = cluster.data;
  if (!c || !nodes.data || single) return null;

  return (
    <div className="space-y-4">
      <Link href="/admin/nodes" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
        ← Hypervisors
      </Link>
      <div>
        <h1 className="text-lg font-semibold">{c.name}</h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {mine.length === 0 ? (
            "Nenhum servidor sincronizado ainda. Confira o token e clique em Sincronizar."
          ) : (
            <>
              Cluster com {mine.length} servidores:{" "}
              {mine.map((n, i) => (
                <span key={n.id}>
                  {i > 0 && ", "}
                  <Link href={`/admin/nodes/${n.id}`} className="text-indigo-600 hover:underline dark:text-indigo-400">
                    {n.name}
                  </Link>
                </span>
              ))}
              .
            </>
          )}
        </p>
      </div>
      <ConnectionSettings cluster={c} nodeCount={mine.length} />
      <ConnectionInstances clusterId={c.id} />
    </div>
  );
}
