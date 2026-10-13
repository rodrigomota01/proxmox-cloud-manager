"""What the platform installs on a cluster it creates (ADR-0018), with fixed versions.

The Kubernetes version comes from the node image (images.kubernetes_version); everything
else comes from here, so two clusters created on the same day get the same components.
Bumping a version is a code change, reviewed like any other.
"""

from dataclasses import dataclass
from functools import cache
from pathlib import Path

SCRIPTS = Path(__file__).parent / "scripts"


@dataclass(frozen=True)
class Bundle:
    gateway_api: str = "1.6.1"  # the version Cilium 1.20 is built against
    cilium: str = "1.20.2"
    metallb: str = "0.16.1"
    cert_manager: str = "1.21.2"
    local_path: str = "0.0.37"
    pod_cidr: str = "10.244.0.0/16"
    service_cidr: str = "10.96.0.0/12"

    def versions(self) -> dict[str, str]:
        return {
            "gateway_api": self.gateway_api, "cilium": self.cilium, "metallb": self.metallb,
            "cert_manager": self.cert_manager, "local_path": self.local_path,
        }


BUNDLE = Bundle()


@cache
def script(name: str) -> str:
    return (SCRIPTS / f"{name}.sh").read_text()


def command(name: str, env: dict[str, str] | None = None) -> list[str]:
    """argv that runs a platform script with its environment. Never put secrets in env:
    they would show in the guest's process list; secrets go through stdin."""
    pairs = [f"{k}={v}" for k, v in (env or {}).items()]
    return ["env", *pairs, "bash", "-c", script(name), name]
