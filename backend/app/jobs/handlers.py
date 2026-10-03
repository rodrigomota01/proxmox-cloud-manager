"""Importing this module registers every job handler (worker entrypoint)."""

from app.alerts import notify as alert_jobs
from app.compute import jobs as compute_jobs
from app.inventory import jobs as inventory_jobs
from app.ipam import service as ipam_jobs
from app.jobs.queue import HANDLERS

__all__ = ["HANDLERS", "alert_jobs", "compute_jobs", "inventory_jobs", "ipam_jobs"]
