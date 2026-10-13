from fastapi import FastAPI

from app.api import products

app = FastAPI()
app.include_router(products.router, prefix="/api")
