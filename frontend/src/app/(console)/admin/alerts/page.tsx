"use client";

import Link from "next/link";

import { AlertSettings } from "@/components/alerts";

export default function PlatformAlertSettingsPage() {
  return (
    <div className="max-w-5xl space-y-4">
      <Link href="/alerts" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
        ← Alertas
      </Link>
      <h1 className="text-lg font-semibold">Regras e canais da plataforma</h1>
      <AlertSettings mode="platform" />
    </div>
  );
}
