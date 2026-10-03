"""Importing this module registers every job handler (worker entrypoint)."""

from app.compute import jobs as compute_jobs
from app.inventory import jobs as inventory_jobs
from app.jobs.queue import HANDLERS

__all__ = ["HANDLERS", "compute_jobs", "inventory_jobs"]
