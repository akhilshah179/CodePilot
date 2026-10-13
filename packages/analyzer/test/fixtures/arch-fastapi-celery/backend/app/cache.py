import os

import redis

cache = redis.Redis.from_url(os.environ["REDIS_URL"])
