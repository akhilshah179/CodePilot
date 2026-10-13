from fastapi import APIRouter, Depends

from app.auth import current_user
from app.services.pricing import get_price
from app.worker import refresh_price

router = APIRouter(prefix="/products")


@router.get("/{product_id}/price")
def read_price(product_id: int):
    return get_price(product_id)


@router.post("/{product_id}/refresh")
def refresh(product_id: int, user=Depends(current_user)):
    refresh_price.delay(product_id)
    return {"queued": True}
