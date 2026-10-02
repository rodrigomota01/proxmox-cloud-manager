"""Fixed-window rate limiting on Redis (INCR + EXPIRE, atomic in one pipeline)."""

import hashlib

from redis.asyncio import Redis

from app.core.errors import RateLimited


async def hit(redis: Redis, bucket: str, key: str, limit: int, window_seconds: int = 60) -> None:
    """Counts one hit; raises RateLimited once `limit` is exceeded within the window.

    The key is hashed so e-mails/IPs never appear in Redis key names.
    """
    digest = hashlib.sha256(key.encode()).hexdigest()[:32]
    name = f"rl:{bucket}:{digest}"
    async with redis.pipeline(transaction=True) as pipe:
        pipe.incr(name)
        pipe.expire(name, window_seconds, nx=True)
        pipe.ttl(name)
        count, _, ttl = await pipe.execute()
    if count > limit:
        raise RateLimited(retry_after=max(int(ttl), 1))
