import os

from celery import Celery

from app.services.pricing import refresh_remote

celery_app = Celery("pricing", broker=os.environ["CELERY_BROKER_URL"])


@celery_app.task
def refresh_price(product_id: int) -> None:
    refresh_remote(product_id)
