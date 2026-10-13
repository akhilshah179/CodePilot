import json
import os

import httpx

from app.cache import cache
from app.db import SessionLocal
from app.models import Price


def get_price(product_id: int) -> dict:
    cached = cache.get(f"price:{product_id}")
    if cached:
        return json.loads(cached)
    db = SessionLocal()
    row = db.query(Price).filter(Price.product_id == product_id).first()
    value = {"product_id": product_id, "amount": row.amount}
    cache.set(f"price:{product_id}", json.dumps(value))
    return value


def refresh_remote(product_id: int) -> dict:
    response = httpx.get(f"{os.environ['PRICING_API_URL']}/prices/{product_id}")
    return response.json()
