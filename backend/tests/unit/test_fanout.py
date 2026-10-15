import asyncio
import uuid

import pytest

from app.inventory.fanout import for_each_cluster

pytestmark = pytest.mark.anyio


async def test_a_hung_server_delays_only_itself(caplog):
    slow, *fast = [uuid.uuid4() for _ in range(5)]
    done: list[uuid.UUID] = []

    async def task(cluster_id: uuid.UUID) -> None:
        if cluster_id == slow:
            await asyncio.sleep(60)
        done.append(cluster_id)

    started = asyncio.get_running_loop().time()
    await for_each_cluster(
        [slow, *fast], task, what="node disk poll", concurrency=2, cluster_timeout=0.2
    )
    elapsed = asyncio.get_running_loop().time() - started
    assert sorted(done) == sorted(fast)
    assert elapsed < 1.0  # the others ran alongside it, not after its deadline each
    assert [r.message for r in caplog.records] == ["node disk poll timed out"]


async def test_a_crash_is_logged_and_the_others_still_run(caplog):
    bad, good = uuid.uuid4(), uuid.uuid4()
    done: list[uuid.UUID] = []

    async def task(cluster_id: uuid.UUID) -> None:
        if cluster_id == bad:
            raise RuntimeError("boom")
        done.append(cluster_id)

    await for_each_cluster([bad, good], task, what="guest disk poll")
    assert done == [good]
    assert any(r.message == "guest disk poll crashed" for r in caplog.records)
