"""Connection to the legacy MySQL/MariaDB database (CM_IPAM_MYSQL_URL).

Only the worker uses it. One short connection per statement: the calls are rare (every
couple of minutes) and the server is remote, so no pool is kept open against it.
"""

from urllib.parse import unquote, urlsplit

import aiomysql


class MysqlDb:
    def __init__(self, url: str, *, timeout: float = 10.0) -> None:
        parts = urlsplit(url)
        if parts.scheme not in ("mysql", "mariadb") or not parts.hostname:
            raise ValueError("CM_IPAM_MYSQL_URL must look like mysql://user:pw@host:3306/db")
        self._conn = {
            "host": parts.hostname, "port": parts.port or 3306,
            "user": unquote(parts.username or ""), "password": unquote(parts.password or ""),
            "db": parts.path.lstrip("/"), "connect_timeout": timeout, "autocommit": True,
        }

    def __repr__(self) -> str:  # never print the password
        return (
            f"{type(self).__name__}({self._conn['user']}@{self._conn['host']}/{self._conn['db']})"
        )

    async def _execute(self, sql: str, args: tuple[object, ...] = ()) -> tuple[list[tuple], int]:
        conn = await aiomysql.connect(**self._conn)
        try:
            async with conn.cursor() as cur:
                count = await cur.execute(sql, args)
                return list(await cur.fetchall()), count
        finally:
            conn.close()
