"""Runs the platform's scripts inside cluster nodes through the QEMU guest agent (ADR-0018).

A script may run for minutes; a job run must stay far below the queue lease. So each
command is started once, its pid recorded as a job event, and polled; when the run's
time budget is spent the job is rescheduled and the next run polls the same pid. If the
pid is gone (the guest rebooted), the command starts again: every script is idempotent.

Outputs are kept in events only for steps that print no secret (`secret=False`), and
only their tail.
"""

import asyncio
import time
from dataclasses import dataclass

from app.compute.models import Instance
from app.jobs.queue import JobContext, JobFailed, Reschedule
from app.providers.base import CloudProvider, GuestAgentUnavailable, GuestExecStatus, ProviderRef

RUN_BUDGET = 240.0  # seconds of polling per job run (the lease is 10 minutes)
POLL = 3.0
TAIL = 1500


@dataclass(frozen=True)
class StepResult:
    exitcode: int
    out: str  # empty for secret steps that were already finished in a previous run


class StepRunner:
    def __init__(self, ctx: JobContext, provider: CloudProvider) -> None:
        self.ctx, self.provider = ctx, provider
        self.deadline = time.monotonic() + RUN_BUDGET

    def _key(self, step: str, node: Instance) -> tuple[str, str]:
        return step, str(node.id)

    async def done(self, step: str, node: Instance) -> bool:
        return any(
            (e.data.get("step"), e.data.get("node")) == self._key(step, node)
            for e in await self.ctx.events("step_done")
        )

    async def pid(self, step: str, node: Instance) -> int | None:
        pid = None
        for e in await self.ctx.events("exec"):
            if (e.data.get("step"), e.data.get("node")) == self._key(step, node):
                pid = e.data.get("pid")  # the latest start wins
        return pid

    async def run(
        self, step: str, node: Instance, command: list[str], *, stdin: str | None = None,
        secret: bool = False,
    ) -> StepResult:
        """Runs `command` on `node` once, across job runs. A non-zero exit fails the job
        with the tail of the output (never for secret steps)."""
        if await self.done(step, node):
            return StepResult(0, "")
        ref = ProviderRef(node.provider_ref)
        pid = await self.pid(step, node)
        while True:
            if pid is None:
                pid = await self.provider.guest_exec_start(ref, command, stdin)
                await self.ctx.event("exec", f"{step} on {node.name}", step=step,
                                     node=str(node.id), pid=pid)
            try:
                status = await self._wait(ref, pid)
            except GuestAgentUnavailable:
                pid = None  # the guest rebooted or the agent restarted: start again
                await asyncio.sleep(POLL)
                continue
            break
        out = "" if secret else (status.out + status.err)[-TAIL:]
        if status.exitcode != 0:
            await self.ctx.event("step_failed", f"{step} on {node.name}", step=step,
                                 node=str(node.id), exitcode=status.exitcode, output=out)
            raise JobFailed(
                "K8S_STEP_FAILED",
                f"{step} failed on {node.name} (exit {status.exitcode})"
                + (f": {out.strip()[-500:]}" if out else ""),
            )
        await self.ctx.event("step_done", f"{step} on {node.name}", step=step,
                             node=str(node.id), output=out)
        return StepResult(0, status.out)

    async def _wait(self, ref: ProviderRef, pid: int) -> GuestExecStatus:
        while True:
            status = await self.provider.guest_exec_status(ref, pid)
            if status.exited:
                return status
            if time.monotonic() > self.deadline:
                raise Reschedule(5, "waiting for a command inside the guest")
            await asyncio.sleep(POLL)

    async def output(self, node: Instance, command: list[str], wait: float = 60) -> str:
        """Runs a short command now and returns its stdout; nothing is recorded (for
        outputs that carry secrets: join command, admin kubeconfig)."""
        ref = ProviderRef(node.provider_ref)
        pid = await self.provider.guest_exec_start(ref, command)
        end = time.monotonic() + wait
        while True:
            status = await self.provider.guest_exec_status(ref, pid)
            if status.exited:
                if status.exitcode != 0:
                    raise JobFailed("K8S_STEP_FAILED", f"{command[0]} failed on {node.name}")
                if status.truncated:
                    raise JobFailed("K8S_STEP_FAILED", f"output truncated on {node.name}")
                return status.out
            if time.monotonic() > end:
                raise Reschedule(5, "a short command inside the guest took too long")
            await asyncio.sleep(1)
