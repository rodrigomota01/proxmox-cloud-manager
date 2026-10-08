"""The legacy table `kubernetes_clusters` (same MySQL as awf_ip_pool): read only.

One row per node: `client` is the cluster name, `role` the node's role. The kubeconfig
(base64) and the certificates' expiry date usually sit on the control-plane row only.
The database user needs SELECT on this table; nothing is ever written to it.
"""

from dataclasses import dataclass
from datetime import date, datetime
from typing import Protocol

from app.infra.mysql import MysqlDb

COLUMNS = "id, client, host, role, certs_expiration_date, api_server_dns, config, modified_at"


@dataclass(frozen=True)
class K8sRow:
    id: int
    client: str
    host: int | None
    role: str | None
    certs_expire_on: date | None
    api_server: str | None
    config: str | None  # base64 kubeconfig: a credential, never logged
    modified_at: datetime | None

    def __repr__(self) -> str:
        return f"K8sRow(id={self.id}, client={self.client!r}, role={self.role!r})"


class K8sSource(Protocol):
    async def fetch(self) -> list[K8sRow]: ...


def _text(value: object) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None


class MysqlK8sSource(MysqlDb):
    async def fetch(self) -> list[K8sRow]:
        rows, _ = await self._execute(
            f"SELECT {COLUMNS} FROM kubernetes_clusters ORDER BY id"  # noqa: S608
        )
        return [
            K8sRow(
                id=int(r[0]), client=str(r[1]).strip(),
                host=int(r[2]) if r[2] is not None else None, role=_text(r[3]),
                certs_expire_on=r[4], api_server=_text(r[5]), config=_text(r[6]),
                modified_at=r[7],
            )
            for r in rows
        ]
